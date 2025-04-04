const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const fs = require('fs')

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Разрешаем запросы с любого источника (для разработки)
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001; // Порт для бэкенда

// Подключение к MongoDB (замени 'your_mongodb_connection_string' на твою строку подключения)
// Пример: 'mongodb://localhost:27017/roulette'
const { QUICKNODE_RPC, MONGO_URI, QUICKNODE_WSS } = require('./config'); // <<< Добавлено

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Маршрут для проверки работы сервера
app.get('/', (req, res) => {
    res.send('Roulette Backend is running!');
});

// Обработка подключения нового Socket.IO клиента
io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
    });

    // Здесь можно будет добавить обработчики событий от клиента, если нужно
});

server.listen(PORT, () => { // <<< Убираем async
    console.log(`Server listening on *:${PORT}`);
    // <<<--- Удаляем весь блок try/catch с fetchHistoricalBets ---<<<
    listenToBets(); // <<< Просто вызываем слушатель событий напрямую
});

// --- Логика для Solana ---
const { Connection, PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const BetModel = require('./models/Bet');

// --- Константы Solana ---
const PROGRAM_ID = new PublicKey('GZB6nqB9xSC8VKwWajtCu2TotPXz1mZCR5VwMLEKDj81');
const idl = require('./roulette_game.json');
const connection = new Connection(QUICKNODE_RPC, { // <<< Добавляем объект конфигурации
    wsEndpoint: QUICKNODE_WSS,                    // <<< Указываем WSS адрес
    commitment: 'confirmed'                       // <<< Переносим commitment сюда
});

// Загрузка кошелька из файла
const walletPath = './id.json'; // <<< Используем относительный путь
const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
const ownerKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
const ownerWallet = new anchor.Wallet(ownerKeypair); // <<< Создаем объект Wallet

// Используем загруженный кошелек в провайдере
const provider = new anchor.AnchorProvider(connection, ownerWallet, { commitment: 'confirmed' }); // <<< Заменяем {} или dummyWallet на ownerWallet
const program = new anchor.Program(idl, PROGRAM_ID, provider);

// Парсер событий Anchor
const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));

async function listenToBets() {
    console.log(`Listening for 'BetsPlaced' events from program ${PROGRAM_ID.toString()} using program.addEventListener...`);

    try {
        const listener = program.addEventListener('BetsPlaced', async (event, slot, signature) => {
            // Событие 'BetsPlaced' получено и УЖЕ РАСПАРСЕНО библиотекой Anchor!
            // 'event' содержит данные события { player, tokenMint, round, bets, total_amount, timestamp }
            // 'slot' и 'signature' также предоставляются

            console.log(`[EventListener] Received 'BetsPlaced' event in slot ${slot}, signature: ${signature}`);
            // console.log('[EventListener] Event data:', JSON.stringify(event, null, 2)); // Можно раскомментировать для детального просмотра данных события

            try {
                // Проверяем, не обработали ли мы уже эту транзакцию
                const existingBet = await BetModel.findOne({ signature: signature });
                if (existingBet) {
                    console.log(`[EventListener] Signature ${signature} already processed. Skipping.`);
                    return; // Пропускаем, если уже есть в БД
                }

                // Данные уже извлечены в 'event'
                const { player, tokenMint, round, bets, timestamp } = event;

                // Готовим промисы для сохранения каждой ставки из события
                const betPromises = bets.map(betDetail => {
                    const newBet = new BetModel({
                        player: player.toString(),
                        round: round.toNumber(), // Убедимся, что round это BN
                        tokenMint: tokenMint.toString(),
                        betAmount: betDetail.amount.toNumber(), // Убедимся, что amount это BN
                        betType: betDetail.betType,
                        betNumbers: betDetail.numbers.filter(n => n <= 36),
                        timestamp: new Date(timestamp.toNumber() * 1000), // Убедимся, что timestamp это BN
                        signature: signature // Используем сигнатуру транзакции
                    });
                    // Атомарно ищем и вставляем, если не найдено
                    return BetModel.findOneAndUpdate(
                        { signature: signature },
                        { $setOnInsert: newBet },
                        { upsert: true, new: false, setDefaultsOnInsert: true }
                    ).catch(err => {
                        console.error(`[EventListener] Error saving bet for signature ${signature}:`, err);
                        return null; // Возвращаем null при ошибке
                    });
                });

                // Ждем сохранения всех ставок из события
                const results = await Promise.all(betPromises);
                const savedCount = results.filter(r => r !== null && r === null).length;
                const skippedCount = results.filter(r => r !== null && r !== null).length;

                // Если были реально сохранены новые ставки
                if (savedCount > 0) {
                    console.log(`[EventListener] Successfully saved/upserted ${savedCount} bet(s) to DB for signature ${signature}`);
                    // Отправляем данные события через Socket.IO
                    io.emit('newBets', {
                        signature: signature,
                        slot: slot,
                        data: event // Отправляем оригинальную структуру события
                    });
                    console.log(`[EventListener] Emitted 'newBets' event via Socket.IO for signature ${signature}`);
                }
                // Если ставки были пропущены
                if (skippedCount > 0) {
                    console.log(`[EventListener] Skipped ${skippedCount} already existing bet(s) for signature ${signature}`);
                }

            } catch (error) {
                console.error(`[EventListener] Error processing event for signature ${signature}:`, error);
            }
        });

        console.log("Event listener attached successfully. Waiting for events...");

        // --- Опционально: Обработка ошибок соединения WebSocket ---
        // Доступ к WebSocket через provider может быть другим или отсутствовать в этой версии
        // Попробуем через connection, как раньше
        const ws = connection._rpcWebSocket;
        if (ws) {
            ws.on('close', (code, reason) => {
                console.warn(`[EventListener] Underlying WebSocket connection closed. Code: ${code}, Reason: ${reason}. Listener might stop working.`);
                // Возможно, потребуется перезапустить listener или весь процесс
            });
            ws.on('error', (error) => {
                console.error(`[EventListener] Underlying WebSocket error:`, error);
            });
        }
        // --- Конец опциональной части ---

    } catch (error) {
        console.error("Failed to attach event listener:", error);
    }
}
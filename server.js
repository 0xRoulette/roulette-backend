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
const provider = new anchor.AnchorProvider(connection, ownerWallet, { commitment: 'confirmed' });
anchor.setProvider(provider); // <<< ДОБАВЬ ЭТУ СТРОКУ: Устанавливаем провайдер глобально

// Инициализируем программу БЕЗ provider в конструкторе
const program = new anchor.Program(idl, PROGRAM_ID, provider); // <<< Возвращаем provider сюда

// Парсер событий Anchor (если мы вернемся к onLogs, он тут)
const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl)); // Эту строку можно пока оставить или закомментировать, т.к. addEventListener ее не использует


async function listenToBets() {
    console.log(`Listening for Logs from program ${PROGRAM_ID.toString()} using connection.onLogs...`);

    try {
        // Используем connection.onLogs напрямую
        const subscriptionId = connection.onLogs(
            PROGRAM_ID, // Слушаем логи только для нашей программы
            async (logsResult, context) => {
                // logsResult содержит { signature, err, logs }
                // context содержит { slot }
                if (logsResult.err) {
                    console.error(`[onLogs] Error in logs subscription for signature ${logsResult.signature}:`, logsResult.err);
                    return;
                }

                const { signature, logs } = logsResult;
                const { slot } = context;

                // console.log(`[onLogs] Received logs in slot ${slot}, signature: ${signature}`); // Можно раскомментировать для отладки

                try {
                    // Парсим логи с помощью нашего eventParser
                    const parsedEvents = [];
                    eventParser.parseLogs(logs, (eventLog) => {
                         // <<<--- ВОЗВРАЩАЕМ ПРОВЕРКУ ---<<<
                        if (eventLog.name === 'BetsPlaced') {
                            // Сохраняем событие вместе со слотом и сигнатурой
                            parsedEvents.push({ event: eventLog.data, slot: slot, signature: signature });
                        }
                         // <<<----------------------------<<<
                    });

                    if (parsedEvents.length === 0) {
                        // В этих логах не было нужного нам события
                        // console.log(`[onLogs] No 'BetsPlaced' events found in logs for signature ${signature}`);
                        return;
                    }

                    console.log(`[onLogs] Found ${parsedEvents.length} 'BetsPlaced' event(s) in logs for signature ${signature}`);

                    // Обрабатываем каждое найденное событие
                    for (const parsed of parsedEvents) {
                        const { event, slot: currentSlot, signature: currentSig } = parsed;

                        // Проверяем, не обработали ли мы уже эту транзакцию
                        const existingBet = await BetModel.findOne({ signature: currentSig });
                        if (existingBet) {
                            console.log(`[onLogs] Signature ${currentSig} already processed. Skipping.`);
                            continue; // Пропускаем, если уже есть в БД
                        }

                        // Извлекаем данные из события
                        const { player, tokenMint, round, bets, timestamp } = event;

                        // Готовим промисы для сохранения каждой ставки из события
                        const betPromises = bets.map(betDetail => {
                            const newBet = new BetModel({
                                player: player.toString(),
                                round: round.toNumber(),
                                tokenMint: tokenMint.toString(),
                                betAmount: betDetail.amount.toNumber(),
                                betType: betDetail.betType,
                                betNumbers: betDetail.numbers.filter(n => n <= 36),
                                timestamp: new Date(timestamp.toNumber() * 1000),
                                signature: currentSig // Используем сигнатуру транзакции
                            });
                            // Атомарно ищем и вставляем, если не найдено
                            return BetModel.findOneAndUpdate(
                                { signature: currentSig },
                                { $setOnInsert: newBet },
                                { upsert: true, new: false, setDefaultsOnInsert: true }
                            ).catch(err => {
                                console.error(`[onLogs] Error saving bet for signature ${currentSig}:`, err);
                                return null;
                            });
                        });

                        // Ждем сохранения всех ставок
                        const results = await Promise.all(betPromises);
                        const savedCount = results.filter(r => r !== null && r === null).length;
                        const skippedCount = results.filter(r => r !== null && r !== null).length;

                        if (savedCount > 0) {
                            console.log(`[onLogs] Successfully saved/upserted ${savedCount} bet(s) to DB for signature ${currentSig}`);
                            // Отправляем событие через Socket.IO
                            io.emit('newBets', {
                                signature: currentSig,
                                slot: currentSlot,
                                data: event
                            });
                            console.log(`[onLogs] Emitted 'newBets' event via Socket.IO for signature ${currentSig}`);
                        }
                        if (skippedCount > 0) {
                            console.log(`[onLogs] Skipped ${skippedCount} already existing bet(s) for signature ${currentSig}`);
                        }
                    }

                } catch (error) {
                    console.error(`[onLogs] Error processing logs for signature ${signature}:`, error);
                }
            },
            'confirmed' // Уровень подтверждения для логов
        );

        console.log(`[onLogs] Subscribed to logs with subscription ID: ${subscriptionId}. Waiting for events...`);

        const ws = connection._rpcWebSocket;
        if (ws) {
            ws.on('close', (code, reason) => {
                console.warn(`[onLogs] Underlying WebSocket connection closed. Code: ${code}, Reason: ${reason}. Subscription ID: ${subscriptionId}. Attempting to resubscribe may be needed.`);
            });
            ws.on('error', (error) => {
                console.error(`[onLogs] Underlying WebSocket error for subscription ${subscriptionId}:`, error);
            });
        }

    } catch (error) {
        console.error("[onLogs] Failed to subscribe to logs:", error);
    }
}
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

server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
    // Добавляем задержку в 1 секунду перед запуском слушателя
    console.log("Waiting 1 second before attaching event listener...");
    setTimeout(() => {
        console.log("Attaching event listener now...");
        listenToBets();
    }, 1000); // 1000 миллисекунд = 1 секунда
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

// Инициализируем программу БЕЗ provider в конструкторе
// const program = new anchor.Program(idl, PROGRAM_ID, provider); // <<< Возвращаем provider сюда

// Парсер событий Anchor (если мы вернемся к onLogs, он тут)
// const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl)); // Эту строку можно пока оставить или закомментировать, т.к. addEventListener ее не использует


async function listenToBets() {
    console.log(`Listening for Logs from program ${PROGRAM_ID.toString()} using connection.onLogs...`);
    const borshCoder = new anchor.BorshCoder(idl); // <<< СОЗДАЕМ КОДЕР ЗДЕСЬ

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
                    // --- НАЧАЛО: Ручной поиск и декодирование события ---
                    let decodedEventData = null;
                    const logDataPrefix = "Program data: ";

                    for (const logLine of logs) {
                        if (logLine.startsWith(logDataPrefix)) {
                            const base64Data = logLine.substring(logDataPrefix.length);
                            // Используем кодер программы для декодирования данных события
                            // null вторым аргументом означает, что имя события не проверяется строго при декодировании
                            const decoded = borshCoder.events.decode(base64Data); // <<< ИСПОЛЬЗУЕМ borshCoder
                            if (decoded) {
                                // В Anchor 0.31 decode может не возвращать имя, так что проверяем, что данные есть
                                // if (eventDef && eventDef.name === 'BetsPlaced') { // Более строгая проверка, если decode вернет имя
                                if (decoded) { // Упрощенная проверка: если что-то декодировалось, считаем, что это оно
                                    console.log(`[ManualDecode] Found and decoded event data for signature ${signature}`);
                                    decodedEventData = decoded;
                                    break; // Нашли и декодировали, выходим из цикла по логам
                                }
                            }
                        }
                    }
                    // --- КОНЕЦ: Ручной поиск и декодирование события ---

                    if (!decodedEventData) {
                        // Событие не найдено или не декодировано
                        // console.log(`[ManualDecode] No 'BetsPlaced' data found or decoded in logs for signature ${signature}`);
                        return;
                    }

                    // Используем декодированные данные
                    const event = decodedEventData;

                    // Проверяем, не обработали ли мы уже эту транзакцию
                    const existingBet = await BetModel.findOne({ signature: signature }); // Используем signature из logsResult
                    if (existingBet) {
                        console.log(`[ManualDecode] Signature ${signature} already processed. Skipping.`);
                        return; // Пропускаем, если уже есть в БД
                    }

                    // Извлекаем данные из декодированного события 'event'
                    const { player, token_mint, round, bets, timestamp } = event.data;

                    // Готовим промисы для сохранения каждой ставки из события
                    const betPromises = bets.map(betDetail => {
                        const newBet = new BetModel({
                            player: player.toString(),
                            round: parseInt(round, 16), // <<< Парсим hex-строку раунда
                            tokenMint: token_mint.toString(),
                            betAmount: parseInt(betDetail.amount, 16), // <<< Парсим hex-строку суммы ставки
                            betType: betDetail.bet_type,
                            betNumbers: betDetail.numbers.filter(n => n <= 36),
                            timestamp: new Date(parseInt(timestamp, 16) * 1000), // <<< Парсим hex-строку timestamp
                            signature: signature // Используем signature из logsResult
                        });
                        // Атомарно ищем и вставляем
                        return BetModel.findOneAndUpdate(
                            { signature: signature },
                            { $setOnInsert: newBet },
                            { upsert: true, new: false, setDefaultsOnInsert: true }
                        ).catch(err => {
                            console.error(`[ManualDecode] Error saving bet for signature ${signature}:`, err);
                            return null;
                        });
                    });

                    // Ждем сохранения всех ставок
                    const results = await Promise.all(betPromises);
                    // Было: const savedCount = results.filter(r => r !== null && r === null).length;
                    const savedCount = results.filter(r => r === null).length; // <<< Исправлено: null означает, что запись была вставлена (сохранена)
                    const skippedCount = results.filter(r => r !== null).length; // <<< Исправлено: не-null означает, что запись уже существовала (пропущена)

                    if (savedCount > 0) {
                        console.log(`[ManualDecode] Successfully saved/upserted ${savedCount} bet(s) to DB for signature ${signature}`);
                        // Отправляем событие через Socket.IO
                        io.emit('newBets', {
                            signature: signature, // Используем signature из logsResult
                            slot: slot,        // Используем slot из context
                            data: event       // Отправляем декодированное событие
                        });
                        console.log(`[ManualDecode] Emitted 'newBets' event via Socket.IO for signature ${signature}`);
                    }
                    if (skippedCount > 0) {
                        console.log(`[ManualDecode] Skipped ${skippedCount} already existing bet(s) for signature ${signature}`);
                    }

                } catch (error) {
                    console.error(`[ManualDecode] Error processing logs for signature ${signature}:`, error);
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
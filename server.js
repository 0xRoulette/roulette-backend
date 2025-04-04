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
    console.log(`Listening for Logs from program ${PROGRAM_ID.toString()} using connection.onLogs...`);

    try {
        // Используем connection.onLogs напрямую
        const subscriptionId = connection.onLogs(
            PROGRAM_ID, // Слушаем логи только для нашей программы
            async (logsResult, context) => {
                console.log(`[DEBUG] onLogs callback triggered. Signature: ${logsResult.signature}, Error: ${logsResult.err}`); // <<< ДОБАВЬ ЭТУ СТРОКУ
                // logsResult содержит { signature, err, logs }
                // context содержит { slot }
                if (logsResult.err) {
                    console.error(`Error in logs subscription for signature ${logsResult.signature}:`, logsResult.err);
                    return;
                }

                const { signature, logs } = logsResult;
                console.log('[DEBUG] Raw logs received:', JSON.stringify(logs, null, 2));

                const { slot } = context;


                // console.log(`Received logs in slot ${slot}, signature: ${signature}`); // Можно раскомментировать для отладки

                try {
                    // Парсим логи с помощью нашего eventParser
                    const parsedEvents = [];
                    eventParser.parseLogs(logs, (eventLog) => {
                        if (eventLog.name === 'BetsPlaced') {
                            parsedEvents.push({ event: eventLog.data, slot: slot, signature: signature });
                        }
                        console.log(`[DEBUG] Parser found event: Name='${eventLog.name}', Data=`, eventLog.data); // Просто логируем все, что найдено
                        parsedEvents.push({ event: eventLog.data, slot: slot, signature: signature }); // Добавляем любое найденное событие
                        // <<<------------------<<<
                    });

                    console.log(`[DEBUG] Parsed events count: ${parsedEvents.length}`); // <<< ДОБАВЬ ЭТУ СТРОКУ
                    if (parsedEvents.length > 0) {
                        console.log('[DEBUG] First parsed event:', JSON.stringify(parsedEvents[0])); // <<< И ЭТУ СТРОКУ
                    }


                    if (parsedEvents.length === 0) {
                        // В этих логах не было нужного нам события
                        return;
                    }

                    console.log(`Found ${parsedEvents.length} BetsPlaced event(s) in logs for signature ${signature}`);

                    // Обрабатываем каждое найденное событие
                    for (const parsed of parsedEvents) {
                        const { event, slot: currentSlot, signature: currentSig } = parsed;

                        // Проверяем, не обработали ли мы уже эту транзакцию
                        // (важно, т.к. onLogs может иногда присылать логи повторно)
                        const existingBet = await BetModel.findOne({ signature: currentSig });
                        if (existingBet) {
                            console.log(`Real-time (onLogs): Signature ${currentSig} already processed. Skipping.`);
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
                                { signature: currentSig /*, можно добавить player/round для большей точности, если нужно */ },
                                { $setOnInsert: newBet },
                                { upsert: true, new: false, setDefaultsOnInsert: true }
                            ).catch(err => {
                                console.error(`Error saving real-time (onLogs) bet for signature ${currentSig}:`, err);
                                return null; // Возвращаем null при ошибке, чтобы Promise.all не упал
                            });
                        });

                        // Ждем сохранения всех ставок из события
                        const results = await Promise.all(betPromises);
                        const savedCount = results.filter(r => r !== null && r === null).length; // Upsert вернул null при вставке
                        const skippedCount = results.filter(r => r !== null && r !== null).length; // Upsert вернул документ при обновлении (т.е. уже был)

                        // Если были реально сохранены новые ставки
                        if (savedCount > 0) {
                            console.log(`Real-time (onLogs): Successfully saved/upserted ${savedCount} bet(s) to DB for signature ${currentSig}`);
                            // Отправляем необработанные данные события через Socket.IO
                            io.emit('newBets', {
                                signature: currentSig,
                                slot: currentSlot,
                                data: event // Отправляем оригинальную структуру события
                            });
                            console.log(`Real-time (onLogs): Emitted 'newBets' event via Socket.IO for signature ${currentSig}`);
                        }
                        // Если ставки были пропущены (уже существовали)
                        if (skippedCount > 0) {
                            console.log(`Real-time (onLogs): Skipped ${skippedCount} already existing bet(s) for signature ${currentSig}`);
                        }
                    }

                } catch (error) {
                    console.error(`Real-time (onLogs): Error processing logs for signature ${signature}:`, error);
                }
            },
            'confirmed' // Уровень подтверждения для логов
        );

        console.log(`Subscribed to logs with subscription ID: ${subscriptionId}. Waiting for events...`);

        // Обработка отключения WebSocket (опционально, для информации)
        const ws = connection._rpcWebSocket; // Доступ к внутреннему WebSocket
        if (ws) {
            ws.on('close', (code, reason) => {
                console.warn(`WebSocket connection closed. Code: ${code}, Reason: ${reason}. Subscription ID: ${subscriptionId}. Attempting to resubscribe may be needed.`);
                // Здесь можно добавить логику переподключения, если нужно
            });
            ws.on('error', (error) => {
                console.error(`WebSocket error for subscription ${subscriptionId}:`, error);
            });
        }


    } catch (error) {
        console.error("Failed to subscribe to logs:", error);
        // Можно попробовать перезапустить подписку через некоторое время
    }
}
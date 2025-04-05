const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const fs = require('fs')
const cors = require('cors'); // <<< Добавляем эту строку

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Разрешенные методы
    allowedHeaders: ['Content-Type', 'Authorization'] // Разрешенные заголовки
}));
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
    // Задержка убрана, слушатель запускается сразу
    console.log("Attaching event listener now...");
    listenToBets(); // Вызываем функцию напрямую
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

                    const uniqueBetsForDbMap = new Map();
                    bets.forEach(betDetail => {
                        // Ключ может включать тип, числа и сумму для уникальности
                        const betKey = `${betDetail.bet_type}-${betDetail.numbers.sort().join(',')}-${betDetail.amount}`;
                        if (!uniqueBetsForDbMap.has(betKey)) {
                            uniqueBetsForDbMap.set(betKey, betDetail);
                        }
                    });
                    const uniqueBetsForDb = Array.from(uniqueBetsForDbMap.values());


                    // Готовим промисы для сохранения КАЖДОЙ УНИКАЛЬНОЙ ставки из события
                    const betPromises = uniqueBetsForDb.map(betDetail => { // <<< Используем uniqueBetsForDb
                        const newBet = new BetModel({
                            player: player.toString(),
                            round: parseInt(round, 16),
                            tokenMint: token_mint.toString(),
                            betAmount: parseInt(betDetail.amount, 16),
                            betType: betDetail.bet_type, // Сохраняем числовое значение enum
                            betNumbers: betDetail.numbers.filter(n => n <= 36),
                            timestamp: new Date(parseInt(timestamp, 16) * 1000),
                            signature: signature // Связываем каждую запись с транзакцией
                        });
                        // Атомарно ищем ПО СИГНАТУРЕ И УНИКАЛЬНОМУ КЛЮЧУ СТАВКИ (для большей надежности)
                        // Или проще оставить поиск только по сигнатуре, как было, т.к. мы уже отфильтровали дубликаты *до* сохранения
                        return BetModel.findOneAndUpdate(
                            // Можно усложнить ключ, чтобы гарантировать уникальность самой ставки,
                            // но проверка existingBet по сигнатуре выше должна быть достаточной.
                            {
                                signature: signature,
                                // Дополнительные поля для уникальности, если нужно:
                                // betType: betDetail.bet_type,
                                // betAmount: parseInt(betDetail.amount, 16)
                                // 'betNumbers': betDetail.numbers.filter(n => n <= 36) // Сортировка важна для сравнения массивов
                            },
                            { $setOnInsert: newBet },
                            { upsert: true, new: false, setDefaultsOnInsert: true }
                        ).catch(err => {
                            console.error(`[ManualDecode] Error saving bet for signature ${signature}:`, err);
                            return null; // Возвращаем null при ошибке сохранения конкретной ставки
                        });
                    });


                    const results = await Promise.all(betPromises);
                    const savedCount = results.filter(r => r === null).length; // null означает, что upsert вставил новый документ
                    const skippedCount = results.length - savedCount; // Остальные были пропущены (уже существовали)

                    if (savedCount > 0) {
                        console.log(`[ManualDecode] Successfully saved/upserted ${savedCount} unique bet(s) to DB for signature ${signature}`);

                        // --- НАЧАЛО: Формирование события для WebSocket с уникальными ставками ---
                        const eventForSocket = {
                            name: event.name, // Сохраняем имя события ('BetsPlaced')
                            data: {
                                player: player, // Адрес игрока (PublicKey)
                                token_mint: token_mint, // Адрес минта (PublicKey)
                                round: round, // Номер раунда (BN)
                                timestamp: timestamp, // Временная метка (BN)
                                // ВАЖНО: Используем массив уникальных ставок, который сохраняли в БД
                                bets: uniqueBetsForDb.map(betDetail => ({
                                    amount: betDetail.amount, // Сумма ставки (BN)
                                    bet_type: betDetail.bet_type, // Тип ставки (enum число)
                                    numbers: betDetail.numbers // Массив чисел
                                }))
                            }
                        };
                        // --- КОНЕЦ: Формирование события для WebSocket ---


                        // Отправляем событие с УНИКАЛЬНЫМИ ставками через Socket.IO
                        io.emit('newBets', {
                            signature: signature,
                            slot: slot,
                            data: eventForSocket // <<< Отправляем модифицированное событие
                        });
                        console.log(`[ManualDecode] Emitted 'newBets' event via Socket.IO for signature ${signature} with ${uniqueBetsForDb.length} unique bet(s).`);

                    } else if (skippedCount > 0) {
                        // Если все ставки были пропущены (т.е. вся транзакция - дубликат), мы сюда не дойдем из-за проверки existingBet выше.
                        // Этот лог может сработать, если были ошибки сохранения части ставок.
                        console.log(`[ManualDecode] Skipped ${skippedCount} already existing/error bet(s) for signature ${signature}. No new bets saved.`);
                    }

                } catch (error) {
                    console.error(`[ManualDecode] Error processing logs for signature ${signature}:`, error);
                }
            },
            'confirmed'
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
app.get('/api/bets', async (req, res) => {
    const roundQuery = req.query.round; // Получаем номер раунда из запроса (?round=...)
    console.log(`[API] Запрос ставок для раунда: ${roundQuery}`);

    if (!roundQuery || isNaN(parseInt(roundQuery))) {
        return res.status(400).json({ error: 'Не указан корректный номер раунда' });
    }

    const roundNumber = parseInt(roundQuery);

    try {
        // Ищем все записи ставок для указанного раунда в MongoDB
        // Используем .lean() для производительности, т.к. нам нужны только данные
        const betsFromDb = await BetModel.find({ round: roundNumber }).lean();

        if (!betsFromDb || betsFromDb.length === 0) {
            console.log(`[API] Ставки для раунда ${roundNumber} не найдены.`);
            return res.json([]); // Возвращаем пустой массив, если ставок нет
        }

        console.log(`[API] Найдено ${betsFromDb.length} записей ставок для раунда ${roundNumber}.`);

        // Группируем ставки по игроку
        const betsGroupedByPlayer = {};
        betsFromDb.forEach(bet => {
            const playerKey = bet.player.toString(); // Убедимся, что ключ - строка
            if (!betsGroupedByPlayer[playerKey]) {
                betsGroupedByPlayer[playerKey] = {
                    player: playerKey,
                    round: bet.round,
                    tokenMint: bet.tokenMint.toString(), // <<< ДОБАВЛЯЕМ tokenMint от первой ставки
                    timestamp: 0, // Будет обновлен на максимальный timestamp ставок игрока
                    bets: []
                };
            }
            // Добавляем детали ставки
            betsGroupedByPlayer[playerKey].bets.push({
                amount: bet.betAmount,
                // Маппим тип ставки из числа в строку ПРЯМО ЗДЕСЬ
                betType: mapBetTypeEnumToString(bet.betType),
                numbers: bet.betNumbers || []
            });
            // Обновляем timestamp группы на самый последний timestamp ставки
            betsGroupedByPlayer[playerKey].timestamp = Math.max(
                betsGroupedByPlayer[playerKey].timestamp,
                new Date(bet.timestamp).getTime() // Используем время из БД
            );
        });

        // Преобразуем объект с группами в массив
        const responseData = betsFromDb.map(bet => ({
            player: bet.player.toString(),
            round: bet.round,
            tokenMint: bet.tokenMint.toString(),
            timestamp: new Date(bet.timestamp).getTime(), // Отправляем timestamp как число
            amount: bet.betAmount, // Отправляем сырую сумму (lamports)
            betType: mapBetTypeEnumToString(bet.betType), // Маппим тип
            numbers: bet.betNumbers || [],
            signature: bet.signature // Добавляем сигнатуру, если нужна на фронте
            // Добавь isMyBet здесь, если это удобнее делать на бэкенде
            // isMyBet: bet.player.toString() === 'АДРЕС_ИГРОКА_ИЗ_ЗАПРОСА?' // Потребует передачи адреса
        }));

        // Сортируем плоский список по времени (самые новые вверху)
        // Можно добавить вторичную сортировку, например, по игроку
        responseData.sort((a, b) => b.timestamp - a.timestamp);

        console.log(`[API] Отправка плоского списка ставок для раунда ${roundNumber}.`);
        res.json(responseData);

    } catch (error) {
        console.error(`[API] Ошибка при получении ставок для раунда ${roundNumber}:`, error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при получении ставок' });
    }
});

// --- Вспомогательная функция маппинга (нужна здесь тоже!) ---
function mapBetTypeEnumToString(enumValue) {
    const betTypeMapping = [
        'Straight',   // 0
        'Split',      // 1
        'Corner',     // 2
        'Street',     // 3
        'SixLine',    // 4
        'FirstFour',  // 5
        'Red',        // 6
        'Black',      // 7
        'Even',       // 8
        'Odd',        // 9
        'Manque',     // 10
        'Passe',      // 11
        'Columns',    // 12
        'P12',        // 13
        'M12',        // 14
        'D12'         // 15
    ];
    if (enumValue >= 0 && enumValue < betTypeMapping.length) {
        return betTypeMapping[enumValue];
    }
    console.warn(`[API mapBetType] Неизвестный bet_type enum: ${enumValue}`);
    return `Unknown (${enumValue})`; // Возвращаем как есть, чтобы не ломать фронт
}
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

const processingSignatures = new Set(); // Множество для отслеживания обрабатываемых сигнатур const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl)); // Эту строку можно пока оставить или закомментировать, т.к. addEventListener ее не использует


async function listenToBets() {
    console.log(`Listening for Logs from program ${PROGRAM_ID.toString()} using connection.onLogs...`);
    const borshCoder = new anchor.BorshCoder(idl);

    try {
        const subscriptionId = connection.onLogs(
            PROGRAM_ID,
            async (logsResult, context) => {
                const { signature, err, logs } = logsResult;
                const { slot } = context;

                if (err) {
                    console.error(`[onLogs] Error in logs subscription for signature ${signature}:`, err);
                    return;
                }

                console.log(`[onLogs] Raw logs array for signature ${signature}:`, JSON.stringify(logs, null, 2));


                // <<<--- НАЧАЛО: Блокировка обработки дублирующихся вызовов onLogs --- >>>
                if (processingSignatures.has(signature)) {
                    console.log(`[onLogs] Signature ${signature} is already being processed. Skipping duplicate call.`);
                    return;
                }
                processingSignatures.add(signature);
                // <<<--- КОНЕЦ: Блокировка --- >>>


                try { // Обернем всю логику в try...finally для снятия блокировки

                    // --- Проверка в БД (остается) ---
                    const existingBet = await BetModel.findOne({ signature: signature });
                    if (existingBet) {
                        console.log(`[ManualDecode] Signature ${signature} already processed and in DB. Skipping.`);
                        return; // Выходим, если уже в БД
                    }

                    // --- Декодирование события ---
                    let decodedEventData = null;
                    const eventName = 'BetsPlaced'; // Имя события из IDL

                    for (const log of logs) {
                        const logPrefix = "Program data: ";
                        if (log.startsWith(logPrefix)) {
                            try {
                                const base64Data = log.substring(logPrefix.length);
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                const event = borshCoder.events.decode(eventDataBuffer);

                                if (event && event.name === eventName) {
                                    console.log(`[ManualDecode] Found and decoded '${eventName}' event in logs for signature ${signature}.`);
                                    decodedEventData = event;
                                    break;
                                } else if (event) {
                                    console.log(`[ManualDecode] Decoded event '${event.name}', but expected '${eventName}'. Skipping log entry.`);
                                } else {
                                    console.log(`[ManualDecode] Failed to decode event from log entry (borshCoder.events.decode returned null/undefined). Log: ${log}`);
                                }
                            } catch (decodeError) {
                                console.error(`[ManualDecode] Error decoding log entry for signature ${signature}. Log: "${log}". Error:`, decodeError);
                            }
                        }
                    }
                    // --- Конец Декодирования ---

                    if (!decodedEventData) {
                        console.log(`[ManualDecode] No 'BetsPlaced' data found or decoded in logs for signature ${signature}`);
                        return; // Выходим, если событие не найдено/декодировано
                    }

                    const event = decodedEventData;
                    console.log(`[Raw Event Data] Signature: ${signature}, Event Name: ${event.name}`);

                    // --- Извлечение и логирование сырых данных ---
                    const { player, token_mint, round, bets, timestamp } = event.data;
                    console.log('[Raw Event Data Details]', {
                        player: player.toBase58(),
                        token_mint: token_mint.toBase58(),
                        round: round.toString(),
                        timestamp: timestamp.toString(),
                        betsCount: bets.length
                    });
                    bets.forEach((bet, index) => {
                        console.log(`  [Raw Bet ${index}] Amount: ${bet.amount.toString()}, Type: ${bet.bet_type}, Nums: ${bet.numbers}`);
                    });
                    // --- Конец логирования ---

                    // --- Дедупликация ставок внутри события ---
                    const uniqueBetsInEvent = new Map();
                    bets.forEach(bet => {
                        const key = `${bet.bet_type}-${bet.numbers.slice().sort().join(',')}`;
                        if (!uniqueBetsInEvent.has(key)) {
                            uniqueBetsInEvent.set(key, bet);
                        } else {
                            console.log(`[ManualDecode] Duplicate bet type/numbers found within the same event, skipping: Type ${bet.bet_type}, Nums ${bet.numbers}`);
                        }
                    });
                    const uniqueBetsToSave = Array.from(uniqueBetsInEvent.values());
                    console.log(`[ManualDecode] Found ${uniqueBetsToSave.length} unique bet definitions in this event.`);
                    // --- Конец дедупликации в событии ---

                    // --- Сохранение в БД ---
                    // Объявляем переменные ЗДЕСЬ, до цикла сохранения
                    let savedCount = 0;
                    let skippedCount = 0;
                    const savedBetDetailsForSocket = []; // Собираем сохраненные для WS

                    // Создаем массив промисов для сохранения каждой уникальной ставки
                    const betSavePromises = uniqueBetsToSave.map(async (betDetail) => {
                        const betDataToSave = {
                            player: player.toBase58(),
                            tokenMint: token_mint.toBase58(),
                            round: Number(round),
                            betAmount: betDetail.amount.toString(), // Сохраняем СТРОКУ lamports
                            betType: betDetail.bet_type, // Сохраняем число enum
                            betNumbers: betDetail.numbers,
                            timestamp: new Date(Number(timestamp) * 1000), // BN timestamp (сек) -> JS Date
                            signature: signature
                        };
                        try {
                            // Опциональная проверка на дубликат в БД (раскомментировать при необходимости)
                            // const existingDbBet = await BetModel.findOne({ signature: signature, betType: betDataToSave.betType, betNumbers: betDataToSave.betNumbers });
                            // if (existingDbBet) {
                            //    console.log(`[ManualDecode] Bet already in DB (sig+type+nums): ${signature}. Skipping save.`);
                            //    skippedCount++; // Увеличиваем счетчик пропущенных
                            //    return null;
                            // }

                            console.log(`[ManualDecode] Saving bet detail to DB: Player ${betDataToSave.player}, Round ${betDataToSave.round}, Amount ${betDataToSave.betAmount}, Type ${betDataToSave.betType}`);
                            const savedBet = await BetModel.create(betDataToSave);
                            savedCount++; // Увеличиваем счетчик сохраненных
                            savedBetDetailsForSocket.push({ // Добавляем данные для WS
                                amount: savedBet.betAmount, // Отправляем строку lamports
                                bet_type: savedBet.betType, // Отправляем число enum
                                numbers: savedBet.betNumbers
                            });
                            return savedBet;
                        } catch (dbError) {
                            console.error(`[ManualDecode] Error saving bet detail (Type: ${betDataToSave.betType}) to DB for signature ${signature}:`, dbError);
                            skippedCount++; // Увеличиваем счетчик пропущенных/ошибочных
                            return null;
                        }
                    });

                    // Дожидаемся выполнения всех промисов сохранения
                    await Promise.all(betSavePromises); // Убрали присвоение в results, т.к. не используется
                    console.log(`[ManualDecode] DB Save Operation Completed: Saved: ${savedCount}, Skipped/Errors: ${skippedCount}`);
                    // --- Конец сохранения в БД ---

                    // --- Отправка WS ---
                    // Используем счетчики и данные, собранные ПОСЛЕ цикла сохранения
                    if (savedCount > 0) {
                        const eventForSocket = {
                            player: player.toBase58(),
                            token_mint: token_mint.toBase58(),
                            round: round.toString(),
                            timestamp: timestamp.toString(),
                            bets: savedBetDetailsForSocket // Массив только сохраненных ставок
                        };
                        io.emit('newBets', { signature, slot, data: eventForSocket });
                        console.log(`[ManualDecode] Emitted 'newBets' event with ${savedCount} bet details.`);
                    } else if (skippedCount > 0) {
                        console.log(`[ManualDecode] Skipped ${skippedCount} bet(s). No emit.`);
                    } else {
                        // Эта ветка сработает, если событие BetsPlaced было пустым (bets: [])
                        console.log(`[ManualDecode] No bets were found in the event to save or skip for signature ${signature}. No emit.`);
                    }
                    // --- Конец Отправки WS ---

                } catch (error) { // Ловим ошибки основной логики (декодирование, сохранение и т.д.)
                    console.error(`[ManualDecode] Error processing logs for signature ${signature}:`, error);
                } finally {
                    // <<<--- ВАЖНО: Снимаем блокировку в любом случае (успех, ошибка, выход) --- >>>
                    processingSignatures.delete(signature);
                }
            }, // Конец async (logsResult, context) =>
            'confirmed'
        ); // Конец connection.onLogs

        // ... остальной код listenToBets ...

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
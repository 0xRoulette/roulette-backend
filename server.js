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
                        // Не нужно удалять из processingSignatures здесь, т.к. мы выходим
                        return; // Выходим, если уже в БД
                    }

                    // --- Декодирование события (остается) ---
                    // --- Декодирование события ---
                    let decodedEventData = null;
                    const eventName = 'BetsPlaced'; // Имя события из IDL

                    for (const log of logs) {
                        // Стандартный префикс для событий, созданных через emit! в Anchor
                        const logPrefix = "Program data: ";
                        if (log.startsWith(logPrefix)) {
                            try {
                                // Убираем префикс и получаем Base64 строку
                                const base64Data = log.substring(logPrefix.length);
                                // Декодируем Base64 в буфер байт
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                // Декодируем буфер с помощью кодера и IDL
                                const event = borshCoder.events.decode(eventDataBuffer);

                                // Проверяем, что декодирование успешно и имя события совпадает
                                if (event && event.name === eventName) {
                                    console.log(`[ManualDecode] Found and decoded '${eventName}' event in logs for signature ${signature}.`);
                                    decodedEventData = event; // Сохраняем результат
                                    break; // Нашли нужное событие, выходим из цикла
                                } else if (event) {
                                    // Событие декодировано, но имя не то (на всякий случай)
                                    console.log(`[ManualDecode] Decoded event '${event.name}', but expected '${eventName}'. Skipping log entry.`);
                                } else {
                                    // Декодер вернул null или undefined
                                    console.log(`[ManualDecode] Failed to decode event from log entry (borshCoder.events.decode returned null/undefined). Log: ${log}`);
                                }
                            } catch (decodeError) {
                                // Ошибка при декодировании Base64 или Borsh
                                console.error(`[ManualDecode] Error decoding log entry for signature ${signature}. Log: "${log}". Error:`, decodeError);
                                // Продолжаем цикл, может быть, событие в другой строке
                            }
                        }
                    }

                    // ... остальной код ...
                    if (!decodedEventData) {
                        console.log(`[ManualDecode] No 'BetsPlaced' data found or decoded in logs for signature ${signature}`);
                        // Блокировку надо снять, т.к. выходим
                        // processingSignatures.delete(signature); // Убрано, т.к. finally сделает это
                        return;
                    }
                    const event = decodedEventData;
                    console.log(`[Raw Event Data] Signature: ${signature}, Event Name: ${event.name}`);

                    // --- Извлечение и логирование сырых данных (остается) ---
                    const { player, token_mint, round, bets, timestamp } = event.data;
                    // ... (логирование сырых данных) ...

                    // --- Дедупликация ставок (остается) ---
                    const uniqueBetsForDbMap = new Map();
                    // ... (код дедупликации) ...
                    const uniqueBetsForDb = Array.from(uniqueBetsForDbMap.values());

                    // --- Сохранение в БД (остается) ---
                    const betPromises = uniqueBetsForDb.map(betDetail => {
                        // ... (код сохранения) ...
                    });
                    const results = await Promise.all(betPromises);
                    // ... (обработка results) ...

                    // --- Отправка WS (остается, с amount.toString() и т.д.) ---
                    if (savedCount > 0) {
                        // ... (формирование eventForSocket с toString()) ...
                        io.emit('newBets', { signature, slot, data: eventForSocket });
                        console.log(`[ManualDecode] Emitted 'newBets' event...`);
                    } else if (skippedCount > 0) {
                        console.log(`[ManualDecode] Skipped ${skippedCount} already existing/error bet(s)...`);
                    }

                } catch (error) { // Ловим ошибки основной логики
                    console.error(`[ManualDecode] Error processing logs for signature ${signature}:`, error);
                } finally {
                    // <<<--- ВАЖНО: Снимаем блокировку в любом случае (успех, ошибка, выход) --- >>>
                    processingSignatures.delete(signature);
                    // Можно добавить задержку перед удалением, если race condition очень жесткий,
                    // но обычно простого delete достаточно.
                    // setTimeout(() => processingSignatures.delete(signature), 500);
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
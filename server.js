const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const fs = require('fs')
const cors = require('cors');
const BN = require('bn.js');
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js');

// --- Configuration ---
const { QUICKNODE_RPC, MONGO_URI, QUICKNODE_WSS } = require('./config');

// --- Solana Initialization ---
// !!! IMPORTANT: Ensure this PROGRAM_ID matches your newly deployed contract !!!
const PROGRAM_ID = new PublicKey(idl.address);
const connection = new Connection(QUICKNODE_RPC, {
    wsEndpoint: QUICKNODE_WSS,
    commitment: 'confirmed'
});
const walletPath = './id.json'; // Path to the backend authority keypair
const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
const ownerKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
const ownerWallet = new anchor.Wallet(ownerKeypair);
const provider = new anchor.AnchorProvider(connection, ownerWallet, { commitment: 'confirmed' });

// --- Anchor Program Initialization ---
// 
//const program = new anchor.Program(idl, PROGRAM_ID, provider);

// --- Database Models ---
const BetModel = require('./models/Bet');
const RoundPayoutModel = require('./models/RoundPayout'); // Предполагая, что файл называется RoundPayout.js
const ClaimRecordModel = require('./models/ClaimRecord'); // <<< ДОБАВИТЬ ЭТУ СТРОКУ


// --- Other Constants ---
// Bet type constants (matching the contract)
const BET_TYPE_STRAIGHT = 0;
const BET_TYPE_SPLIT = 1;
const BET_TYPE_CORNER = 2;
const BET_TYPE_STREET = 3;
const BET_TYPE_SIX_LINE = 4;
const BET_TYPE_FIRST_FOUR = 5;
const BET_TYPE_RED = 6;
const BET_TYPE_BLACK = 7;
const BET_TYPE_EVEN = 8;
const BET_TYPE_ODD = 9;
const BET_TYPE_MANQUE = 10;
const BET_TYPE_PASSE = 11;
const BET_TYPE_COLUMN = 12;
const BET_TYPE_P12 = 13;
const BET_TYPE_M12 = 14;
const BET_TYPE_D12 = 15;
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]); // Set of red numbers for payout calculation
const processingSignatures = new Set(); // Tracks signatures currently being processed to prevent duplicates

// --- Express and Socket.IO Setup ---
const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for development
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 3001;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Roulette Backend is running!');
});

// Handle new Socket.IO connections
io.on('connection', (socket) => {
    // <<< ДОБАВЛЕНО ЛОГИРОВАНИЕ >>>
    console.log(`[Socket.IO] User CONNECTED: ${socket.id} from ${socket.handshake.address}. Total clients: ${io.engine.clientsCount}`);

    socket.on('disconnect', (reason) => {
        // <<< ДОБАВЛЕНО ЛОГИРОВАНИЕ >>>
        console.log(`[Socket.IO] User DISCONNECTED: ${socket.id}. Reason: ${reason}. Total clients: ${io.engine.clientsCount}`);
    });

    // <<< ДОБАВЛЕНО ЛОГИРОВАНИЕ ОШИБОК СОКЕТА >>>
    socket.on('error', (error) => {
        console.error(`[Socket.IO] Socket ERROR for ID ${socket.id}:`, error);
    });

    // Client-specific event handlers can be added here
});

// <<< ДОБАВЛЕНО ЛОГИРОВАНИЕ ОШИБОК СЕРВЕРА >>>
io.engine.on("connection_error", (err) => {
    console.error("[Socket.IO Engine] Connection Error:");
    console.error(`  Code: ${err.code}`);      // Например, 1
    console.error(`  Message: ${err.message}`); // Например, "Session ID unknown"
    console.error(`  Context: ${JSON.stringify(err.context)}`); // Дополнительные данные об ошибке
});


// Start the server and attach event listener
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
    console.log("Attaching Solana event listener now..."); // Изменено для ясности
    listenToEvents();
});


// Main function to listen for program logs and process events
async function listenToEvents() {
    console.log(`[Solana Listener] Listening for Logs from program ${PROGRAM_ID.toString()}...`); // Изменено для ясности

    let idl;
    let borshCoder; // Объявляем здесь

    // <<< НАЧАЛО: Правильный блок для загрузки IDL и создания Coder >>>
    try {
        console.log("[Solana Listener] Attempting to require IDL './roulette_game.json'..."); // Изменено для ясности
        idl = require('./roulette_game.json'); // Сначала ЗАГРУЖАЕМ IDL
        console.log("[Solana Listener] IDL required successfully. Attempting to create BorshCoder..."); // Изменено для ясности
        // <<< ИСПРАВЛЕНИЕ: Создаем borshCoder ПОСЛЕ загрузки idl >>>
        borshCoder = new anchor.BorshCoder(idl);
        console.log("[Solana Listener] BorshCoder created successfully."); // Изменено для ясности
    } catch (error) {
        console.error("[Solana Listener] [FATAL] Failed to load IDL or create BorshCoder:", error); // Изменено для ясности
        return; // Выходим, если ошибка
    }
    // <<< КОНЕЦ: Правильный блок >>>

    // Теперь можно безопасно использовать borshCoder дальше
    try {
        console.log(`[Solana Listener] Attempting to subscribe to logs for program ${PROGRAM_ID.toString()}...`); // Изменено для ясности
        const subscriptionId = connection.onLogs(
            PROGRAM_ID,
            async (logsResult, context) => { // <<< НАЧАЛО КОЛЛБЭКА
                // <<< ПОПЫТКА ДЕСТРУКТУРИЗАЦИИ >>>
                const { signature, err, logs } = logsResult; // Переменные объявлены здесь
                const { slot } = context;
                // <<< КОНЕЦ ПОПЫТКИ >>>

                // <<< ЛОГИРОВАНИЕ RAW ДАННЫХ >>>
                console.log(`\n--- [Solana Log Received] Signature: ${signature} | Slot: ${slot} | Error: ${err} ---`);
                if (logs) {
                    logs.forEach((log, index) => console.log(`  [Raw Log ${index}] ${log.substring(0, 200)}...`));
                } else {
                    console.log("  [Raw Log] No logs array received.");
                }
                // <<< КОНЕЦ ЛОГИРОВАНИЯ RAW ДАННЫХ >>>


                if (err) {
                    console.error(`[Solana Listener] Error in logs subscription payload for signature ${signature}:`, err); // Изменено для ясности
                    return;
                }
                 // Добавляем проверку на null или undefined для logs
                 if (!logs) {
                     console.warn(`[Solana Listener] Received log payload without 'logs' array for signature ${signature}. Skipping.`); // Изменено для ясности
                     return;
                 }
                // Предотвращаем повторную обработку одной и той же транзакции
                if (processingSignatures.has(signature)) {
                    console.log(`[Solana Listener] Signature ${signature} already being processed, skipping.`); // Изменено для ясности
                    return;
                }
                processingSignatures.add(signature);
                console.log(`[Solana Listener] START Processing signature: ${signature}`); // Изменено для ясности

                try {
                    // --- Флаги для предотвращения дублирования обработки событий в одной транзакции ---
                    let isBetPlacedProcessed = false;
                    let isRandomGeneratedProcessed = false; // Переименовано для ясности
                    let isWinningsClaimedProcessed = false;
                    let isBetsClosedProcessed = false;
                    let isRoundStartedProcessed = false;

                    for (const log of logs) {
                        const logPrefix = "Program data: ";
                        if (log.startsWith(logPrefix)) {
                            const base64Data = log.substring(logPrefix.length);
                            let event; // Объявляем event здесь
                            try {
                                // <<< ДОБАВЛЕНО ЛОГИРОВАНИЕ ДЕКОДИРОВАНИЯ >>>
                                console.log(`  [Event Decode] Attempting for signature ${signature}: ${base64Data.substring(0, 50)}...`);
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                event = borshCoder.events.decode(eventDataBuffer); // Присваиваем значение
                                console.log(`  [Event Decode] Success for signature ${signature}. Event Name: ${event?.name || 'NULL'}`);
                                // <<< КОНЕЦ ЛОГИРОВАНИЯ ДЕКОДИРОВАНИЯ >>>

                            } catch (decodeError) {
                                // <<< УЛУЧШЕНО ЛОГИРОВАНИЕ ОШИБКИ ДЕКОДИРОВАНИЯ >>>
                                console.error(`  [Event Decode] FAILED for signature ${signature}:`, decodeError.message);
                                console.error(`  [Event Decode] Failed log content: ${log}`);
                                continue; // Пропускаем этот лог, если не смогли декодировать
                            }

                                if (!event) continue; // Пропускаем, если декодирование вернуло null

                                // --- BetPlaced Event Handler ---
                                if (event.name === 'BetPlaced' && !isBetPlacedProcessed) {
                                    console.log(`[Event Handler - BetPlaced] START processing for signature ${signature}...`); // <<< ЛОГ НАЧАЛА
                                    const { player, token_mint, round, bet, timestamp } = event.data;

                                    const betDataToSave = {
                                        player: player.toBase58(),
                                        tokenMint: token_mint.toBase58(),
                                        round: Number(round),
                                        betAmount: bet.amount.toString(),
                                        betType: bet.bet_type, // Сохраняем числовое значение
                                        betNumbers: bet.numbers,
                                        timestamp: new Date(Number(timestamp) * 1000),
                                        signature: signature,
                                    };

                                    try {
                                        // Использование findOneAndUpdate с upsert: true уже обрабатывает случай отсутствия
                                        await BetModel.findOneAndUpdate(
                                            { signature: signature }, // Ищем по уникальной подписи
                                            betDataToSave,
                                            { upsert: true, new: true } // Создать, если нет, вернуть новый документ
                                        );
                                        console.log(`[Event Handler - BetPlaced] DB Upsert OK for signature ${signature}.`); // <<< ЛОГ УСПЕХА DB

                                        const eventForSocket = {
                                            player: player.toBase58(),
                                            token_mint: token_mint.toBase58(),
                                            round: round.toString(), // Строка для совместимости?
                                            timestamp: Number(timestamp), // Секунды
                                            bet: {
                                                amount: bet.amount.toString(),
                                                bet_type: bet.bet_type, // Число для сокета
                                                numbers: bet.numbers
                                            },
                                            signature: signature
                                        };
                                        io.emit('newBet', eventForSocket);
                                        console.log(`[Event Handler - BetPlaced] Emitted 'newBet' via Socket.IO. Sig: ${signature}.`); // <<< ЛОГ УСПЕХА EMIT
                                        isBetPlacedProcessed = true;
                                    } catch (dbError) {
                                        console.error(`[Event Handler - BetPlaced] DB ERROR for signature ${signature}:`, dbError); // <<< ЛОГ ОШИБКИ DB
                                    }
                                }
                                // --- RoundStarted Event Handler ---
                                else if (event.name === 'RoundStarted' && !isRoundStartedProcessed) {
                                    console.log(`[Event Handler - RoundStarted] START processing for signature ${signature}...`); // <<< ЛОГ НАЧАЛА
                                    const { round, starter, start_time } = event.data;

                                    const eventForSocket = {
                                        round: Number(round),
                                        starter: starter.toBase58(),
                                        startTime: Number(start_time) * 1000, // В миллисекундах
                                        signature: signature
                                    };
                                    io.emit('roundStarted', eventForSocket);
                                    console.log(`[Event Handler - RoundStarted] Emitted 'roundStarted' (Round: ${eventForSocket.round}). Sig: ${signature}.`); // <<< ЛОГ УСПЕХА EMIT
                                    isRoundStartedProcessed = true;
                                }
                                // --- BetsClosed Event Handler ---
                                else if (event.name === 'BetsClosed' && !isBetsClosedProcessed) {
                                     console.log(`[Event Handler - BetsClosed] START processing for signature ${signature}...`); // <<< ЛОГ НАЧАЛА
                                    const { round, closer, close_time } = event.data;

                                    const eventForSocket = {
                                        round: Number(round),
                                        closer: closer.toBase58(),
                                        closeTime: Number(close_time) * 1000, // В миллисекундах
                                        signature: signature
                                    };
                                    io.emit('betsClosed', eventForSocket);
                                    console.log(`[Event Handler - BetsClosed] Emitted 'betsClosed' (Round: ${eventForSocket.round}). Sig: ${signature}.`); // <<< ЛОГ УСПЕХА EMIT
                                    isBetsClosedProcessed = true;
                                }
                                // --- RandomGenerated Event Handler (ИЗМЕНЕНИЯ) ---
                                else if (event.name === 'RandomGenerated' && !isRandomGeneratedProcessed) {
                                    console.log(`[Event Handler - RandomGenerated] START processing for signature ${signature}...`); // <<< ЛОГ НАЧАЛА
                                    const { round, initiator, winning_number, generation_time, slot, last_bettor } = event.data;
                                    const roundNum = Number(round);
                                    const winningNum = Number(winning_number);
                                    const generationTimeMs = Number(generation_time) * 1000; // Время генерации

                                    try {
                                        // --- Получение всех ставок раунда из БД ---
                                        const betsForRound = await BetModel.find({ round: roundNum }).lean();
                                        console.log(`[Event Handler - RandomGenerated] Found ${betsForRound.length} bets in DB for round ${roundNum}. Sig: ${signature}.`); // <<< ЛОГ DB FIND

                                        const playerPayouts = new Map(); // Map<playerAddress, { totalPayout: BN, tokenMint: string }>
                                        const payoutsToSave = []; // Для RoundPayoutModel

                                        if (betsForRound.length > 0) {
                                            let roundTokenMint = null; // Определим минт из первой валидной ставки
                                            for (const betRecord of betsForRound) {
                                                if (!roundTokenMint && betRecord.tokenMint) {
                                                    roundTokenMint = betRecord.tokenMint.toString();
                                                }
                                                // ... (Проверки и расчеты выигрышей как раньше) ...
                                                if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) continue;
                                                let betAmountBN;
                                                try { betAmountBN = new BN(betRecord.betAmount); } catch { continue; }

                                                const isWinningBet = isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum);
                                                if (isWinningBet) {
                                                    const multiplier = calculatePayoutMultiplier(betRecord.betType);
                                                    const payoutAmountBN = betAmountBN.mul(multiplier);

                                                    const playerAddress = betRecord.player; // Уже строка из БД
                                                    const tokenMint = betRecord.tokenMint; // Уже строка из БД
                                                    const currentData = playerPayouts.get(playerAddress) || { totalPayout: new BN(0), tokenMint: tokenMint };

                                                    if (currentData.tokenMint !== tokenMint) {
                                                         console.error(`[Event Handler - RandomGenerated] [FATAL] Mismatched mints for player ${playerAddress} in round ${roundNum}. Skipping payout calculation.`);
                                                         playerPayouts.delete(playerAddress);
                                                         continue;
                                                    }
                                                    playerPayouts.set(playerAddress, {
                                                        totalPayout: currentData.totalPayout.add(payoutAmountBN),
                                                        tokenMint: tokenMint
                                                    });
                                                }
                                            }
                                        } else {
                                            console.log(`[Event Handler - RandomGenerated] No bets found for round ${roundNum}. Sig: ${signature}.`);
                                        }
                                        // --- КОНЕЦ расчета выигрышей ---

                                        // --- Подготовка данных для сохранения RoundPayoutModel ---
                                        let tokenMintForRound = null; // Переопределяем здесь, на случай если ставок не было
                                        for (const [player, data] of playerPayouts.entries()) {
                                            payoutsToSave.push({ address: player, amount: data.totalPayout.toString() });
                                             // Устанавливаем tokenMintForRound из первой найденной выплаты
                                             if (!tokenMintForRound) tokenMintForRound = data.tokenMint;
                                        }
                                        // Если ставок не было, tokenMintForRound останется null

                                        // --- Сохранение результатов раунда в RoundPayoutModel ---
                                        await RoundPayoutModel.findOneAndUpdate(
                                            { round: roundNum },
                                            {
                                                round: roundNum,
                                                winningNumber: winningNum,
                                                payouts: payoutsToSave,
                                                // Можно добавить generation_time и initiator, если нужно
                                                generationTimestamp: new Date(generationTimeMs),
                                                initiator: initiator.toBase58()
                                            },
                                            { upsert: true, new: true, setDefaultsOnInsert: true }
                                        );
                                        console.log(`[Event Handler - RandomGenerated] Saved/Updated RoundPayout for round ${roundNum}. Payouts: ${payoutsToSave.length}. Sig: ${signature}.`); // <<< ЛОГ УСПЕХА DB

                                        // --- Отправка события 'winningsCalculated' по WebSocket ---
                                        const eventForSocket = {
                                            round: roundNum,
                                            winningNumber: winningNum,
                                            generation_time: Number(generation_time), // Секунды, как в контракте
                                            initiator: initiator.toBase58(),
                                            signature: signature
                                            // НЕ отправляем массив ставок здесь
                                        };
                                        io.emit('winningsCalculated', eventForSocket);
                                        console.log(`[Event Handler - RandomGenerated] Emitted 'winningsCalculated' (Round: ${roundNum}, Num: ${winningNum}). Sig: ${signature}.`); // <<< ЛОГ УСПЕХА EMIT

                                        isRandomGeneratedProcessed = true; // Помечаем, что обработали
                                    } catch (payoutDbError) {
                                        console.error(`[Event Handler - RandomGenerated] DB/Processing ERROR for round ${roundNum}, Sig ${signature}:`, payoutDbError); // <<< ЛОГ ОШИБКИ
                                    }
                                }
                                // --- WinningsClaimed Event Handler ---
                                else if (event.name === 'WinningsClaimed' && !isWinningsClaimedProcessed) {
                                     console.log(`[Event Handler - WinningsClaimed] START processing for signature ${signature}...`); // <<< ЛОГ НАЧАЛА
                                    const { round, player, token_mint, amount, timestamp } = event.data;
                                    const roundNum = Number(round);
                                    const playerAddr = player.toBase58();
                                    const claimTimestamp = Number(timestamp) * 1000;

                                    try {
                                        // Сохраняем запись о клейме в БД
                                        await ClaimRecordModel.findOneAndUpdate(
                                            { player: playerAddr, round: roundNum }, // Ключ для поиска
                                            {
                                                player: playerAddr,
                                                round: roundNum,
                                                claimSignature: signature, // Сохраняем подпись клейма
                                                claimedTimestamp: new Date(claimTimestamp),
                                                tokenMint: token_mint.toBase58(),
                                                amountClaimed: amount.toString(),
                                            },
                                            { upsert: true, new: true } // Создать или обновить
                                        );
                                        console.log(`[Event Handler - WinningsClaimed] DB Upsert OK for player ${playerAddr}, round ${roundNum}. Sig: ${signature}.`); // <<< ЛОГ УСПЕХА DB

                                        // Отправляем событие по WebSocket
                                        const eventForSocket = {
                                            round: roundNum,
                                            player: playerAddr,
                                            tokenMint: token_mint.toBase58(),
                                            amount: amount.toString(),
                                            timestamp: claimTimestamp, // В миллисекундах
                                            claimSignature: signature
                                        };
                                        io.emit('winningsClaimed', eventForSocket);
                                        console.log(`[Event Handler - WinningsClaimed] Emitted 'winningsClaimed' for player ${playerAddr}, round ${roundNum}. Sig: ${signature}.`); // <<< ЛОГ УСПЕХА EMIT
                                        isWinningsClaimedProcessed = true;
                                    } catch (dbError) {
                                        console.error(`[Event Handler - WinningsClaimed] DB ERROR for player ${playerAddr}, round ${roundNum}, Sig ${signature}:`, dbError); // <<< ЛОГ ОШИБКИ DB
                                    }
                                }

                            } // End if log.startsWith(logPrefix)
                        } // End for loop over logs

                } catch (processingError) {
                    console.error(`[Solana Listener] Outer processing ERROR for signature ${signature}:`, processingError); // <<< ЛОГ ВНЕШНЕЙ ОШИБКИ
                } finally {
                    processingSignatures.delete(signature);
                    console.log(`[Solana Listener] END Processing signature: ${signature}`); // <<< ЛОГ ОКОНЧАНИЯ
                    console.log(`--- [END Solana Log Processing] Signature: ${signature} ---`); // Добавим разделитель
                }

            }, // <<< КОНЕЦ КОЛЛБЭКА onLogs
            'confirmed' // Используем 'confirmed' или 'finalized' в зависимости от требований
        );

        console.log(`[Solana Listener] Successfully subscribed to logs. Subscription ID: ${subscriptionId}`);

    } catch (error) {
        console.error("[Solana Listener] [FATAL] Failed to subscribe to logs:", error);
    }
}

// --- API Routes ---

// Endpoint to fetch historical bets for a specific round
app.get('/api/bets', async (req, res) => {
    const roundQuery = req.query.round;
    // <<< Добавляем логирование запроса >>>
    console.log(`[API /api/bets] Request received. Round: ${roundQuery}`);

    if (!roundQuery || isNaN(parseInt(roundQuery))) {
        console.warn(`[API /api/bets] Invalid round number: ${roundQuery}`); // <<< Лог ошибки валидации
        return res.status(400).json({ error: 'Valid round number required' });
    }
    const roundNumber = parseInt(roundQuery);

    try {
        const betsFromDb = await BetModel.find({
            round: roundNumber,
        }).sort({ timestamp: -1 }).lean();

        if (!betsFromDb || betsFromDb.length === 0) {
            console.log(`[API /api/bets] No bets found for round ${roundNumber}.`);
            return res.json([]); // Возвращаем пустой массив, как и было
        }
        console.log(`[API /api/bets] Found ${betsFromDb.length} bet records for round ${roundNumber}.`);

        // Преобразование данных для ответа
        const responseData = betsFromDb.map(bet => ({
            player: bet.player, // Уже строка из БД
            round: bet.round,
            tokenMint: bet.tokenMint, // Уже строка из БД
            timestamp: new Date(bet.timestamp).getTime(),
            amount: bet.betAmount, // Строка lamports
            betType: mapBetTypeEnumToString(bet.betType), // Преобразуем в строку
            numbers: bet.betNumbers || [],
            signature: bet.signature
        }));

        console.log(`[API /api/bets] Sending ${responseData.length} bets for round ${roundNumber}.`); // <<< Лог ответа
        res.json(responseData);

    } catch (error) {
        console.error(`[API /api/bets] Error fetching bets for round ${roundNumber}:`, error); // <<< Лог ошибки
        res.status(500).json({ error: 'Internal server error while fetching bets' });
    }
});

app.get('/api/round-payouts', async (req, res) => {
    const roundQuery = req.query.round;
    // <<< Добавляем логирование запроса >>>
    console.log(`[API /api/round-payouts] Request received. Round: ${roundQuery}`);

    if (!roundQuery || isNaN(parseInt(roundQuery))) {
        console.warn(`[API /api/round-payouts] Invalid round number: ${roundQuery}`); // <<< Лог ошибки валидации
        return res.status(400).json({ error: 'Valid round number required' });
    }
    const roundNumber = parseInt(roundQuery);

    try {
        const roundPayoutData = await RoundPayoutModel.findOne({
            round: roundNumber,
        }).lean();

        if (!roundPayoutData) {
            console.log(`[API /api/round-payouts] No payout data found for round ${roundNumber}. Sending 404.`); // <<< Лог ответа 404
            return res.status(404).json({ error: 'Payout data not found for this round' });
        }

        console.log(`[API /api/round-payouts] Found payout data for round ${roundNumber}. Winners: ${roundPayoutData.payouts?.length || 0}.`); // <<< Лог найденных данных
        res.json({
            round: roundPayoutData.round,
            winningNumber: roundPayoutData.winningNumber,
            payouts: roundPayoutData.payouts || [],
            createdAt: roundPayoutData.createdAt,
            // Добавим данные из события, если они есть
            generationTimestamp: roundPayoutData.generationTimestamp,
            initiator: roundPayoutData.initiator,
        });

    } catch (error) {
        console.error(`[API /api/round-payouts] Error fetching payout data for round ${roundNumber}:`, error); // <<< Лог ошибки
        res.status(500).json({ error: 'Internal server error while fetching payout data' });
    }
});

// --- НОВЫЙ ЭНДПОИНТ: Получить ВСЕ ставки игрока за раунд с метками выигрыша ---
app.get('/api/player-round-bets', async (req, res) => {
    const { player, round } = req.query;
    // <<< Добавляем логирование запроса >>>
    console.log(`[API /api/player-round-bets] Request received. Player: ${player}, Round: ${round}`);

    // Валидация входных данных
    if (!player || !round || isNaN(parseInt(round))) {
         console.warn(`[API /api/player-round-bets] Invalid input. Player: ${player}, Round: ${round}`); // <<< Лог ошибки валидации
        return res.status(400).json({ error: 'Valid player public key and round number required' });
    }
    try {
        new PublicKey(player);
    } catch (e) {
         console.warn(`[API /api/player-round-bets] Invalid player public key format: ${player}`); // <<< Лог ошибки валидации
        return res.status(400).json({ error: 'Invalid player public key format' });
    }
    const roundNumber = parseInt(round);
    const playerPubkeyStr = player;

    try {
        // 1. Проверяем, был ли уже забран выигрыш за этот раунд
        const existingClaim = await ClaimRecordModel.findOne({ player: playerPubkeyStr, round: roundNumber }).lean();
        const alreadyClaimed = !!existingClaim;
        console.log(`[API /api/player-round-bets] Already claimed status for player ${playerPubkeyStr}, round ${roundNumber}: ${alreadyClaimed}`); // <<< Лог статуса клейма

        // 2. Получаем информацию о раунде (выигрышное число)
        const roundPayoutData = await RoundPayoutModel.findOne({ round: roundNumber }).lean();
        let winningNum = null;
        if (roundPayoutData && roundPayoutData.winningNumber !== undefined && roundPayoutData.winningNumber !== null) {
            winningNum = roundPayoutData.winningNumber;
             console.log(`[API /api/player-round-bets] Winning number for round ${roundNumber}: ${winningNum}`); // <<< Лог выигрышного числа
        } else {
             console.log(`[API /api/player-round-bets] Winning number not found yet for round ${roundNumber}.`); // <<< Лог отсутствия числа
        }

        // 3. Получаем все ставки этого игрока за этот раунд
        const playerBetsInRound = await BetModel.find({ player: playerPubkeyStr, round: roundNumber })
                                        .sort({ timestamp: 1 })
                                        .lean();

        if (!playerBetsInRound || playerBetsInRound.length === 0) {
            console.log(`[API /api/player-round-bets] No bets found for player ${playerPubkeyStr} in round ${roundNumber}.`); // <<< Лог отсутствия ставок
            return res.json({ bets: [], alreadyClaimed });
        }
         console.log(`[API /api/player-round-bets] Found ${playerBetsInRound.length} bets for player ${playerPubkeyStr} in round ${roundNumber}. Formatting...`); // <<< Лог количества ставок

        // 4. Форматируем результат
        const allPlayerBetsDetails = [];
        for (const betRecord of playerBetsInRound) {
             // ... (расчеты isWinningBet и payoutAmountBN как раньше) ...
             if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) continue;
             let betAmountBN;
             try { betAmountBN = new BN(betRecord.betAmount); } catch { continue; }

             const isWinningBet = (winningNum !== null)
                                  ? isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum)
                                  : false;

            let payoutAmountBN = new BN(0);
            if (isWinningBet) {
                const multiplier = calculatePayoutMultiplier(betRecord.betType);
                payoutAmountBN = betAmountBN.mul(multiplier);
            }

            allPlayerBetsDetails.push({
                round: roundNumber,
                tokenMint: betRecord.tokenMint, // Уже строка
                betType: mapBetTypeEnumToString(betRecord.betType),
                numbers: betRecord.betNumbers || [],
                amountBet: betRecord.betAmount,
                isWinning: isWinningBet,
                payoutAmount: payoutAmountBN.toString(),
                signature: betRecord.signature,
                timestamp: new Date(betRecord.timestamp).getTime(),
            });
        }

        console.log(`[API /api/player-round-bets] Sending ${allPlayerBetsDetails.length} formatted bets for player ${playerPubkeyStr}, round ${roundNumber}. Claimed: ${alreadyClaimed}`); // <<< Лог ответа
        res.json({ bets: allPlayerBetsDetails, alreadyClaimed });

    } catch (error) {
        console.error(`[API /api/player-round-bets] Error fetching bets for player ${playerPubkeyStr}, round ${roundNumber}:`, error); // <<< Лог ошибки
        res.status(500).json({ error: 'Internal server error while fetching player bets' });
    }
});

// --- НОВЫЙ ЭНДПОИНТ: Проверка и данные для клейма последнего раунда игрока ---
app.get('/api/latest_bets', async (req, res) => {
    const { player } = req.query;
    // Используем старый цветной лог для этого эндпоинта
    console.log(`%c[API LatestBets] Request for player: ${player}`, 'color: magenta;');

    // 1. Валидация Pubkey
    if (!player) {
         console.warn(`%c[API LatestBets] Player public key missing.`, 'color: orange;');
        return res.status(400).json({ error: 'Player public key required' });
    }
    let playerPubkey;
    try {
        playerPubkey = new PublicKey(player);
    } catch (e) {
        console.warn(`%c[API LatestBets] Invalid player public key format: ${player}`, 'color: orange;');
        return res.status(400).json({ error: 'Invalid player public key format' });
    }
    const playerPubkeyStr = playerPubkey.toBase58();

    try {
        // 2. Найти последний раунд с участием игрока
        const latestBet = await BetModel.findOne({ player: playerPubkeyStr })
                                       .sort({ round: -1 })
                                       .lean();

        if (!latestBet) {
            console.log(`%c[API LatestBets] No bets found for player ${playerPubkeyStr}. Sending claimable: false.`, 'color: magenta;');
            return res.json({ claimable: false });
        }
        const playerLatestRound = latestBet.round;
        console.log(`%c[API LatestBets] Player ${playerPubkeyStr} latest participation round: ${playerLatestRound}. Checking completion...`, 'color: magenta;');

        // 3. Проверить, завершен ли этот раунд
        const roundData = await RoundPayoutModel.findOne({ round: playerLatestRound }).lean();
        if (!roundData || roundData.winningNumber === undefined || roundData.winningNumber === null) {
            console.log(`%c[API LatestBets] Round ${playerLatestRound} is not completed or winning number not found. Sending claimable: false.`, 'color: magenta;');
            return res.json({ claimable: false });
        }
        const winningNum = roundData.winningNumber;
        console.log(`%c[API LatestBets] Round ${playerLatestRound} completed. Winning number: ${winningNum}. Checking claim status...`, 'color: magenta;');

        // 4. Проверить, забрал ли игрок выигрыш за этот раунд
        const existingClaim = await ClaimRecordModel.findOne({ player: playerPubkeyStr, round: playerLatestRound }).lean();
        if (existingClaim) {
            console.log(`%c[API LatestBets] Player ${playerPubkeyStr} already claimed winnings for round ${playerLatestRound}. Sending claimable: false.`, 'color: magenta;');
            return res.json({ claimable: false });
        }
        console.log(`%c[API LatestBets] Player ${playerPubkeyStr} has NOT claimed winnings for round ${playerLatestRound}. Calculating payout...`, 'color: magenta;');

        // 5. Рассчитать выигрыш за этот раунд
        const playerBetsInRound = await BetModel.find({ player: playerPubkeyStr, round: playerLatestRound }).lean();

        if (!playerBetsInRound || playerBetsInRound.length === 0) {
            console.warn(`%c[API LatestBets] Inconsistency: Found latest round ${playerLatestRound} but no bets for player ${playerPubkeyStr}. Sending claimable: false.`, 'color: red;');
            return res.json({ claimable: false });
        }

        let totalPayoutBN = new BN(0);
        let roundTokenMint = null;
        const betsDetails = [];

        for (const betRecord of playerBetsInRound) {
            if (!roundTokenMint) roundTokenMint = betRecord.tokenMint; // Строка из БД
            if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) continue;
            let betAmountBN;
            try { betAmountBN = new BN(betRecord.betAmount); } catch { continue; }

            const isWinningBet = isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum);
            let payoutAmountBN = new BN(0);
            if (isWinningBet) {
                const multiplier = calculatePayoutMultiplier(betRecord.betType);
                payoutAmountBN = betAmountBN.mul(multiplier);
                totalPayoutBN = totalPayoutBN.add(payoutAmountBN);
            }

            betsDetails.push({
                round: playerLatestRound,
                tokenMint: betRecord.tokenMint, // Строка
                betType: mapBetTypeEnumToString(betRecord.betType),
                numbers: betRecord.betNumbers || [],
                amountBet: betRecord.betAmount,
                isWinning: isWinningBet,
                payoutAmount: payoutAmountBN.toString(),
                signature: betRecord.signature,
                timestamp: new Date(betRecord.timestamp).getTime(),
            });
        }

         console.log(`%c[API LatestBets] Calculated total payout for player ${playerPubkeyStr} in round ${playerLatestRound}: ${totalPayoutBN.toString()} lamports.`, 'color: magenta;');

        // 6. Вернуть результат
        if (totalPayoutBN.gtn(0)) {
            const response = {
                claimable: true,
                roundNumber: playerLatestRound,
                tokenMint: roundTokenMint,
                totalPayout: totalPayoutBN.toString(),
                bets: betsDetails
            };
            console.log(`%c[API LatestBets] Sending claimable response for player ${playerPubkeyStr}: claimable=${response.claimable}, round=${response.roundNumber}, mint=${response.tokenMint}, payout=${response.totalPayout}, numBets=${response.bets.length}`, 'color: green; font-weight: bold;');
            return res.json(response);
        } else {
             console.log(`%c[API LatestBets] Player ${playerPubkeyStr} has no winnings in round ${playerLatestRound}. Sending claimable: false.`, 'color: magenta;');
            return res.json({ claimable: false });
        }

    } catch (error) {
        console.error(`%c[API LatestBets] Error processing request for player ${playerPubkeyStr}:`, 'color: red;', error);
        res.status(500).json({ error: 'Internal server error while checking latest bets' });
    }
});

// --- Payout Calculation Helper Functions ---

// Calculates the payout multiplier based on the bet type enum
function calculatePayoutMultiplier(betType) {
    switch (betType) {
        case BET_TYPE_STRAIGHT: return new BN(36);
        case BET_TYPE_SPLIT: return new BN(18);
        case BET_TYPE_CORNER: return new BN(9);
        case BET_TYPE_STREET: return new BN(12);
        case BET_TYPE_SIX_LINE: return new BN(6);
        case BET_TYPE_FIRST_FOUR: return new BN(9);
        case BET_TYPE_RED: return new BN(2);
        case BET_TYPE_BLACK: return new BN(2);
        case BET_TYPE_EVEN: return new BN(2);
        case BET_TYPE_ODD: return new BN(2);
        case BET_TYPE_MANQUE: return new BN(2);
        case BET_TYPE_PASSE: return new BN(2);
        case BET_TYPE_COLUMN: return new BN(3);
        case BET_TYPE_P12: return new BN(3);
        case BET_TYPE_M12: return new BN(3);
        case BET_TYPE_D12: return new BN(3);
        default: return new BN(0); // Unknown bet type
    }
}

// Determines if a bet is a winner based on its type, numbers, and the winning number
function isBetWinner(betType, numbers, winningNumber) {
    // Ensure inputs are numbers
    winningNumber = Number(winningNumber);
    numbers = numbers.map(n => Number(n));

    switch (betType) {
        case BET_TYPE_STRAIGHT: return numbers[0] === winningNumber;
        case BET_TYPE_SPLIT: return numbers[0] === winningNumber || numbers[1] === winningNumber;
        case BET_TYPE_CORNER:
            const topLeft = numbers[0];
            // Corner bet validation (cannot start from rightmost column or last row, or involve 0 this way)
            if (topLeft % 3 === 0 || topLeft > 34 || topLeft === 0) return false;
            const cornerNumbers = [topLeft, topLeft + 1, topLeft + 3, topLeft + 4];
            return cornerNumbers.includes(winningNumber);
        case BET_TYPE_STREET:
            const startStreet = numbers[0];
            // Street bet validation (must start with 1, 4, 7... up to 34)
            if ((startStreet - 1) % 3 !== 0 || startStreet > 34 || startStreet < 1) return false;
            // Winning number must be within the street range and not 0
            return winningNumber >= startStreet && winningNumber < startStreet + 3 && winningNumber !== 0;
        case BET_TYPE_SIX_LINE:
            const startSixLine = numbers[0];
            // Six Line bet validation (must start with 1, 4, 7... up to 31)
            if ((startSixLine - 1) % 3 !== 0 || startSixLine > 31 || startSixLine < 1) return false;
            // Winning number must be within the six line range and not 0
            return winningNumber >= startSixLine && winningNumber < startSixLine + 6 && winningNumber !== 0;
        case BET_TYPE_FIRST_FOUR: return [0, 1, 2, 3].includes(winningNumber);
        case BET_TYPE_RED: return RED_NUMBERS.has(winningNumber);
        case BET_TYPE_BLACK: return winningNumber !== 0 && !RED_NUMBERS.has(winningNumber); // Zero is not black
        case BET_TYPE_EVEN: return winningNumber !== 0 && winningNumber % 2 === 0; // Zero is not even
        case BET_TYPE_ODD: return winningNumber !== 0 && winningNumber % 2 === 1; // Zero is not odd
        case BET_TYPE_MANQUE: return winningNumber >= 1 && winningNumber <= 18;
        case BET_TYPE_PASSE: return winningNumber >= 19 && winningNumber <= 36;
        case BET_TYPE_COLUMN:
            const column = numbers[0]; // Column number (1, 2, or 3)
            if (column < 1 || column > 3) return false;
            // Check column based on modulo 3 (0 is not in any column)
            // Column 1 => winningNumber % 3 == 1
            // Column 2 => winningNumber % 3 == 2
            // Column 3 => winningNumber % 3 == 0
            return winningNumber !== 0 && (winningNumber % 3 === column % 3);
        case BET_TYPE_P12: return winningNumber >= 1 && winningNumber <= 12;
        case BET_TYPE_M12: return winningNumber >= 13 && winningNumber <= 24;
        case BET_TYPE_D12: return winningNumber >= 25 && winningNumber <= 36;
        default: return false; // Unknown bet type
    }
}


// --- Helper function to map bet type enum (number) to string (needed for API) ---
function mapBetTypeEnumToString(enumValue) {
    const betTypeMapping = [
        'Straight', 'Split', 'Corner', 'Street', 'SixLine',
        'FirstFour', 'Red', 'Black', 'Even', 'Odd', 'Manque',
        'Passe', 'Column', 'P12', 'M12', 'D12'
    ];
    if (enumValue >= 0 && enumValue < betTypeMapping.length) {
        return betTypeMapping[enumValue];
    }
    console.warn(`[mapBetType] Unknown bet_type enum: ${enumValue}`);
    return `Unknown (${enumValue})`; // Return gracefully for unknown types
}
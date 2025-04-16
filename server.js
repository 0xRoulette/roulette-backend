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
const PROGRAM_ID = new PublicKey('32T21T93tobSziz7QSojRwsDiWawnr66ys2db8WbBioF');
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
    console.log('a user connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
    });
    // Client-specific event handlers can be added here
});

// Start the server and attach event listener
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
    console.log("Attaching event listener now...");
    listenToEvents();
});


// Main function to listen for program logs and process events
async function listenToEvents() {
    console.log(`Listening for Logs from program ${PROGRAM_ID.toString()}...`);

    let idl;
    let borshCoder; // Объявляем здесь

    // <<< НАЧАЛО: Правильный блок для загрузки IDL и создания Coder >>>
    try {
        console.log("[Debug] Attempting to require IDL './roulette_game.json'...");
        idl = require('./roulette_game.json'); // Сначала ЗАГРУЖАЕМ IDL
        console.log("[Debug] IDL required successfully. Attempting to create BorshCoder...");
        // <<< ИСПРАВЛЕНИЕ: Создаем borshCoder ПОСЛЕ загрузки idl >>>
        borshCoder = new anchor.BorshCoder(idl);
        console.log("[Debug] BorshCoder created successfully.");
    } catch (error) {
        console.error("[FATAL] Failed to load IDL or create BorshCoder:", error);
        return; // Выходим, если ошибка
    }
    // <<< КОНЕЦ: Правильный блок >>>

    // Теперь можно безопасно использовать borshCoder дальше
    try {
        console.log(`[Debug] Attempting to subscribe to logs for program ${PROGRAM_ID.toString()}...`);
        const subscriptionId = connection.onLogs(
            PROGRAM_ID,
            async (logsResult, context) => { // <<< НАЧАЛО КОЛЛБЭКА
                // <<< УДАЛИ ЭТИ ДВЕ СТРОКИ (124 и 125) >>>
                // console.log(`[onLogs Raw] Received logs for sig: ${signature}, err: ${err}, log count: ${logs?.length}`); // <<< УДАЛИТЬ
                // if (logs) { // <<< УДАЛИТЬ
                //     logs.forEach((log, index) => console.log(`[onLogs Raw Log ${index}] ${log.substring(0, 150)}...`)); // <<< УДАЛИТЬ
                // } // <<< УДАЛИТЬ

                // <<< ПОПЫТКА ДЕСТРУКТУРИЗАЦИИ >>>
                const { signature, err, logs } = logsResult; // Переменные объявлены здесь
                const { slot } = context;
                // <<< КОНЕЦ ПОПЫТКИ >>>

                // <<< ОСТАВЬ ЭТИ ЛОГИ (Они уже в правильном месте) >>>
                console.log(`[onLogs Raw] Received logs for sig: ${signature}, err: ${err}, log count: ${logs?.length}`);
                if (logs) {
                    logs.forEach((log, index) => console.log(`[onLogs Raw Log ${index}] ${log.substring(0, 150)}...`));
                }
                // <<< КОНЕЦ ПРАВИЛЬНЫХ ЛОГОВ >>>


                if (err) {
                    console.error(`[onLogs] Error in logs subscription for signature ${signature}:`, err);
                    return;
                }
                // Предотвращаем повторную обработку одной и той же транзакции
                if (processingSignatures.has(signature)) {
                    // console.log(`[onLogs] Signature ${signature} already being processed, skipping.`);
                    return;
                }
                processingSignatures.add(signature);
                console.log(`[onLogs] Processing signature: ${signature} at slot ${slot}`);

                try {
                    // --- Флаги для предотвращения дублирования обработки событий в одной транзакции ---
                    let isBetPlacedProcessed = false;
                    let isRandomGeneratedProcessed = false;
                    let isWinningsClaimedProcessed = false;
                    let isBetsClosedProcessed = false;
                    let isRoundStartedProcessed = false;

                    for (const log of logs) {
                        const logPrefix = "Program data: ";
                        if (log.startsWith(logPrefix)) {
                            try {
                                const base64Data = log.substring(logPrefix.length);
                                console.log(`[Decode Attempt] Trying to decode: ${base64Data.substring(0, 50)}...`); // <<< ДОБАВЬ
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                const event = borshCoder.events.decode(eventDataBuffer);
                                console.log(`[Decode Result] Decoded event name: ${event?.name}`); // <<< ДОБАВЬ

                                if (!event) continue;

                                // --- BetPlaced Event Handler ---
                                if (event.name === 'BetPlaced' && !isBetPlacedProcessed) {
                                    console.log(`[BetPlaced] Processing event for signature ${signature}...`);
                                    const { player, token_mint, round, bet, timestamp } = event.data;

                                    const betDataToSave = {
                                        player: player.toBase58(),
                                        tokenMint: token_mint.toBase58(),
                                        round: Number(round),
                                        betAmount: bet.amount.toString(),
                                        betType: bet.bet_type,
                                        betNumbers: bet.numbers,
                                        timestamp: new Date(Number(timestamp) * 1000),
                                        signature: signature,
                                    };

                                    try {
                                        await BetModel.findOneAndUpdate(
                                            {
                                                signature: signature,
                                            },
                                            betDataToSave,
                                            { upsert: true, new: true }
                                        );

                                        const eventForSocket = {
                                            player: player.toBase58(),
                                            token_mint: token_mint.toBase58(),
                                            round: round.toString(),
                                            timestamp: Number(timestamp),
                                            bet: {
                                                amount: bet.amount.toString(),
                                                bet_type: bet.bet_type,
                                                numbers: bet.numbers
                                            },
                                            signature: signature
                                        };
                                        io.emit('newBet', eventForSocket);
                                        console.log(`[BetPlaced] Emitted 'newBet' event via Socket.IO.`);
                                        isBetPlacedProcessed = true;
                                    } catch (dbError) {
                                        console.error(`[BetPlaced] Error saving/upserting bet to DB for signature ${signature}:`, dbError);
                                    }
                                }
                                // --- RoundStarted Event Handler ---
                                else if (event.name === 'RoundStarted' && !isRoundStartedProcessed) {
                                    console.log(`[RoundStarted] Processing event for signature ${signature}...`);
                                    const { round, starter, start_time } = event.data;

                                    const eventForSocket = {
                                        round: Number(round),
                                        starter: starter.toBase58(),
                                        startTime: Number(start_time) * 1000, // В миллисекундах
                                        signature: signature
                                    };
                                    io.emit('roundStarted', eventForSocket);
                                    console.log(`[RoundStarted] Emitted 'roundStarted' (Round: ${eventForSocket.round}) event via Socket.IO.`);
                                    isRoundStartedProcessed = true;
                                }
                                // --- BetsClosed Event Handler ---
                                else if (event.name === 'BetsClosed' && !isBetsClosedProcessed) {
                                    console.log(`[BetsClosed] Processing event for signature ${signature}...`);
                                    const { round, closer, close_time } = event.data;

                                    const eventForSocket = {
                                        round: Number(round),
                                        closer: closer.toBase58(),
                                        closeTime: Number(close_time) * 1000, // В миллисекундах
                                        signature: signature
                                    };
                                    io.emit('betsClosed', eventForSocket);
                                    console.log(`[BetsClosed] Emitted 'betsClosed' (Round: ${eventForSocket.round}) event via Socket.IO.`);
                                    isBetsClosedProcessed = true;
                                }
                                // --- RandomGenerated Event Handler (ИЗМЕНЕНИЯ) ---
                                else if (event.name === 'RandomGenerated' && !isRandomGeneratedProcessed) {
                                    console.log(`[RandomGenerated] Processing event for signature ${signature}...`);
                                    const { round, initiator, winning_number, generation_time, slot, last_bettor } = event.data;
                                    const roundNum = Number(round);
                                    const winningNum = Number(winning_number);

                                    // --- Получение всех ставок раунда из БД ---
                                    const betsForRound = await BetModel.find({ round: roundNum }).lean();
                                    console.log(`[RandomGenerated] Found ${betsForRound.length} bet records in DB for round ${roundNum}. Calculating results...`);

                                    const detailedBetResults = []; // Массив для отправки на фронтенд
                                    const playerPayouts = new Map(); // Map<playerAddress, { totalPayout: BN, tokenMint: string }> (для RoundPayoutModel)
                                    const payoutsToSave = []; // Для RoundPayoutModel

                                    if (betsForRound.length > 0) {
                                        for (const betRecord of betsForRound) {
                                            // Проверка betAmount
                                            if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) {
                                                console.warn(`[RandomGenerated] Skipping bet record with invalid betAmount for player ${betRecord.player}, round ${roundNum}. Amount:`, betRecord.betAmount);
                                                continue;
                                            }
                                            let betAmountBN;
                                            try { betAmountBN = new BN(betRecord.betAmount); } catch (bnError) { console.error(`[RandomGenerated] Error converting betAmount '${betRecord.betAmount}' to BN. Skipping.`, bnError); continue; }

                                            const isWinningBet = isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum);
                                            let payoutAmountBN = new BN(0);
                                            let multiplier = new BN(0); // Инициализируем множитель

                                            if (isWinningBet) {
                                                multiplier = calculatePayoutMultiplier(betRecord.betType); // Рассчитываем множитель
                                                payoutAmountBN = betAmountBN.mul(multiplier); // Рассчитываем выигрыш по ставке

                                                // Обновляем общие выплаты для RoundPayoutModel (логика остается)
                                                const playerAddress = betRecord.player;
                                                const tokenMint = betRecord.tokenMint;
                                                const currentData = playerPayouts.get(playerAddress) || { totalPayout: new BN(0), tokenMint: tokenMint };
                                                if (currentData.tokenMint !== tokenMint) {
                                                     console.error(`[FATAL] Mismatched mints for player ${playerAddress} in round ${roundNum}. Skipping payout calculation.`);
                                                     playerPayouts.delete(playerAddress); // Удаляем игрока, чтобы избежать проблем
                                                     continue; // Пропускаем эту ставку для playerPayouts
                                                }
                                                playerPayouts.set(playerAddress, {
                                                    totalPayout: currentData.totalPayout.add(payoutAmountBN),
                                                    tokenMint: tokenMint
                                                });
                                            }

                                            // Формируем объект для отправки на фронтенд
                                            detailedBetResults.push({
                                                player: betRecord.player.toString(),
                                                round: roundNum,
                                                tokenMint: betRecord.tokenMint.toString(),
                                                betType: mapBetTypeEnumToString(betRecord.betType), // Строковое представление
                                                numbers: betRecord.betNumbers || [],
                                                amountBet: betRecord.betAmount, // Сумма ставки (строка)
                                                isWinning: isWinningBet,
                                                payoutAmount: payoutAmountBN.toString(), // Сумма выигрыша по этой ставке (строка)
                                                signature: betRecord.signature,
                                            });
                                        }
                                        console.log(`[RandomGenerated] Calculated detailed results for ${detailedBetResults.length} bets.`);
                                    } else {
                                        console.log(`[RandomGenerated] No bets found for round ${roundNum}. No results calculated.`);
                                    }
                                    // --- КОНЕЦ расчета выигрышей ---

                                    // --- Подготовка данных для сохранения RoundPayoutModel (без изменений) ---
                                    let tokenMintForRound = null;
                                    for (const [player, data] of playerPayouts.entries()) {
                                        payoutsToSave.push({ address: player, amount: data.totalPayout.toString() });
                                        if (!tokenMintForRound) tokenMintForRound = data.tokenMint;
                                    }

                                    // --- Сохранение результатов раунда в RoundPayoutModel (без изменений) ---
                                    // Сохраняем, если были победители ИЛИ если ставок не было вообще (чтобы записать winningNumber)
                                    if (payoutsToSave.length > 0 || betsForRound.length === 0) {
                                        try {
                                            await RoundPayoutModel.findOneAndUpdate(
                                                { round: roundNum },
                                                {
                                                    round: roundNum,
                                                    winningNumber: winningNum,
                                                    payouts: payoutsToSave, // Сохраняем общий payout для истории/проверки
                                                },
                                                { upsert: true, new: true, setDefaultsOnInsert: true }
                                            );
                                            console.log(`[RandomGenerated] Saved/Updated RoundPayout data for round ${roundNum}. Payouts array length: ${payoutsToSave.length}`);
                                        } catch (payoutDbError) {
                                            console.error(`[RandomGenerated] Error saving RoundPayout data for round ${roundNum}:`, payoutDbError);
                                        }
                                    } else {
                                        console.log(`[RandomGenerated] No winning payouts to save for round ${roundNum}, but bets existed. Still saving round info.`);
                                         // Опционально: сохранить запись RoundPayout даже без победителей, если были ставки
                                        try {
                                            await RoundPayoutModel.findOneAndUpdate(
                                                { round: roundNum },
                                                {
                                                    round: roundNum,
                                                    winningNumber: winningNum,
                                                    payouts: [], // Пустой массив, т.к. победителей не было
                                                },
                                                { upsert: true, new: true, setDefaultsOnInsert: true }
                                            );
                                             console.log(`[RandomGenerated] Saved RoundPayout data for round ${roundNum} with empty payouts array.`);
                                        } catch (payoutDbError) {
                                            console.error(`[RandomGenerated] Error saving RoundPayout data (no winners) for round ${roundNum}:`, payoutDbError);
                                        }
                                    }
                                    // --- КОНЕЦ Сохранения ---

                                    // --- Отправка по WebSocket (НОВЫЙ СПОСОБ) ---
                                    // Отправляем массив с деталями всех ставок раунда
                                    io.emit('roundBetsResult', detailedBetResults);
                                    console.log(`%c[WebSocket] Emitted 'roundBetsResult' event for round ${roundNum} with ${detailedBetResults.length} bet details.`, 'color: blue; font-weight: bold;');
                                    // --- КОНЕЦ отправки по WebSocket ---

                                    isRandomGeneratedProcessed = true; // Помечаем, что обработали
                                }
                                // --- WinningsClaimed Event Handler ---
                                else if (event.name === 'WinningsClaimed' && !isWinningsClaimedProcessed) {
                                    console.log(`[WinningsClaimed] Processing event for signature ${signature}...`);
                                    const { round, player, token_mint, amount, timestamp } = event.data;
                                    const roundNum = Number(round);
                                    const playerAddr = player.toBase58();
                                    const claimTimestamp = Number(timestamp) * 1000;

                                    // Сохраняем запись о клейме в БД
                                    try {
                                        await ClaimRecordModel.findOneAndUpdate(
                                            { player: playerAddr, round: roundNum },
                                            {
                                                player: playerAddr,
                                                round: roundNum,
                                                claimSignature: signature, // Сохраняем подпись клейма
                                                claimedTimestamp: new Date(claimTimestamp),
                                                tokenMint: token_mint.toBase58(), // Можно добавить минт и сумму, если нужно
                                                amountClaimed: amount.toString(),
                                            },
                                            { upsert: true, new: true } // Создать, если нет, или обновить
                                        );
                                        console.log(`[WinningsClaimed] Saved/Updated ClaimRecord for player ${playerAddr}, round ${roundNum}.`);
                                    } catch (dbError) {
                                        // Обработка ошибки дубликата подписи, если нужно (хотя findOneAndUpdate с upsert должен справиться)
                                        if (dbError.code === 11000 && dbError.keyPattern && dbError.keyPattern.claimSignature) {
                                             console.warn(`[WinningsClaimed] Claim signature ${signature} already exists. Ignoring DB update.`);
                                        } else if (dbError.code === 11000 && dbError.keyPattern && dbError.keyPattern['player'] && dbError.keyPattern['round']) {
                                             console.warn(`[WinningsClaimed] Claim record for player ${playerAddr}, round ${roundNum} already exists. Updating timestamp/signature potentially.`);
                                             // Можно добавить логику обновления, если нужно
                                        }
                                         else {
                                             console.error(`[WinningsClaimed] Error saving ClaimRecord for player ${playerAddr}, round ${roundNum}:`, dbError);
                                         }
                                    }

                                    // Отправляем событие по WebSocket (оставляем, т.к. может быть полезно для UI)
                                    const eventForSocket = {
                                        round: roundNum,
                                        player: playerAddr,
                                        tokenMint: token_mint.toBase58(),
                                        amount: amount.toString(),
                                        timestamp: claimTimestamp, // В миллисекундах
                                        claimSignature: signature
                                    };
                                    io.emit('winningsClaimed', eventForSocket);
                                    console.log(`[WinningsClaimed] Emitted 'winningsClaimed' for player ${eventForSocket.player} round ${eventForSocket.round}.`);
                                    isWinningsClaimedProcessed = true;
                                }

                            } catch (decodeError) {
                                console.error(`[EventDecode] Error decoding log for signature ${signature}:`, decodeError);
                                console.error(`[EventDecode] Failed log content:`, log);
                            }
                        } // End if log.startsWith(logPrefix)
                    } // End for loop over logs

                } catch (processingError) {
                    console.error(`[onLogs] Error processing signature ${signature}:`, processingError);
                } finally {
                    // Убедимся, что сигнатура удаляется, даже если была ошибка при обработке
                    processingSignatures.delete(signature);
                    // console.log(`[onLogs] Finished processing signature: ${signature}`);
                }

            },
            'confirmed' // Используем 'confirmed' или 'finalized' в зависимости от требований
        );

        console.log(`[onLogs] Successfully subscribed to logs. Subscription ID: ${subscriptionId}`); // Этот лог мы ищем

    } catch (error) {
        console.error("[onLogs] Failed to subscribe to logs:", error);
        // Здесь можно добавить логику переподключения или оповещения
    }
}

// --- API Routes ---

// Endpoint to fetch historical bets for a specific round
app.get('/api/bets', async (req, res) => {
    const roundQuery = req.query.round;
    console.log(`[API Bets] Request for round: ${roundQuery}`);

    if (!roundQuery || isNaN(parseInt(roundQuery))) {
        return res.status(400).json({ error: 'Valid round number required' });
    }
    const roundNumber = parseInt(roundQuery);

    try {
        // <<< НАЧАЛО ИЗМЕНЕНИЙ: Добавляем фильтр по gameSessionPubkey >>>
        const betsFromDb = await BetModel.find({
            round: roundNumber,
        }).sort({ timestamp: -1 }).lean();
        // <<< КОНЕЦ ИЗМЕНЕНИЙ: Добавляем фильтр по gameSessionPubkey >>>

        if (!betsFromDb || betsFromDb.length === 0) {
            console.log(`[API Bets] No bets found for round ${roundNumber}.`);
            return res.json([]);
        }
        console.log(`[API Bets] Found ${betsFromDb.length} bet records for round ${roundNumber}.`);

        // Преобразование данных для ответа остается прежним
        const responseData = betsFromDb.map(bet => ({
            player: bet.player.toString(),
            round: bet.round,
            tokenMint: bet.tokenMint.toString(),
            timestamp: new Date(bet.timestamp).getTime(),
            amount: bet.betAmount,
            betType: mapBetTypeEnumToString(bet.betType),
            numbers: bet.betNumbers || [],
            signature: bet.signature
        }));

        console.log(`[API Bets] Sending flat list of bets for round ${roundNumber}.`);
        res.json(responseData);

    } catch (error) {
        console.error(`[API Bets] Error fetching bets for round ${roundNumber}:`, error);
        res.status(500).json({ error: 'Internal server error while fetching bets' });
    }
});

app.get('/api/round-payouts', async (req, res) => {
    const roundQuery = req.query.round;
    console.log(`[API Payouts] Request for round: ${roundQuery}`);

    if (!roundQuery || isNaN(parseInt(roundQuery))) {
        return res.status(400).json({ error: 'Valid round number required' });
    }
    const roundNumber = parseInt(roundQuery);

    try {
        const roundPayoutData = await RoundPayoutModel.findOne({
            round: roundNumber,
        }).lean(); // .lean() для получения простого JS объекта

        if (!roundPayoutData) {
            console.log(`[API Payouts] No payout data found for round ${roundNumber}.`);
            // Возвращаем 404 или пустой объект/массив, в зависимости от того, как фронтенд будет это обрабатывать
            return res.status(404).json({ error: 'Payout data not found for this round' });
            // Или: return res.json({ winningNumber: null, payouts: [] });
        }

        console.log(`[API Payouts] Found payout data for round ${roundNumber}. Winners: ${roundPayoutData.payouts?.length || 0}.`);
        // Возвращаем только нужные поля (или весь документ, если удобно)
        res.json({
            round: roundPayoutData.round,
            winningNumber: roundPayoutData.winningNumber,
            payouts: roundPayoutData.payouts || [], // Массив { address, amount }
            createdAt: roundPayoutData.createdAt // Полезно знать, когда были рассчитаны выплаты
        });

    } catch (error) {
        console.error(`[API Payouts] Error fetching payout data for round ${roundNumber}:`, error);
        res.status(500).json({ error: 'Internal server error while fetching payout data' });
    }
});

// --- НОВЫЙ ЭНДПОИНТ: Получить ВСЕ ставки игрока за раунд с метками выигрыша ---
app.get('/api/player-round-bets', async (req, res) => { // Переименовал для ясности
    const { player, round } = req.query;
    console.log(`[API PlayerBets] Request for player: ${player}, round: ${round}`);

    // Валидация входных данных
    if (!player || !round || isNaN(parseInt(round))) {
        return res.status(400).json({ error: 'Valid player public key and round number required' });
    }
    try {
        new PublicKey(player); // Проверяем, валидный ли pubkey
    } catch (e) {
        return res.status(400).json({ error: 'Invalid player public key format' });
    }
    const roundNumber = parseInt(round);
    const playerPubkeyStr = player;

    try {
        // 1. Проверяем, был ли уже забран выигрыш за этот раунд (для информации)
        const existingClaim = await ClaimRecordModel.findOne({ player: playerPubkeyStr, round: roundNumber }).lean();
        const alreadyClaimed = !!existingClaim; // true, если запись есть, иначе false

        // 2. Получаем информацию о раунде (выигрышное число)
        // Нам нужно winningNumber, даже если уже забрано, чтобы пометить ставки правильно
        const roundPayoutData = await RoundPayoutModel.findOne({ round: roundNumber }).lean();
        let winningNum = null; // Изначально null
        if (roundPayoutData && roundPayoutData.winningNumber !== undefined && roundPayoutData.winningNumber !== null) {
            winningNum = roundPayoutData.winningNumber;
        } else {
             // Если winningNumber еще нет, значит раунд не завершен.
             // Мы все равно можем вернуть ставки, но isWinning будет всегда false.
             console.log(`[API PlayerBets] Winning number not found for round ${roundNumber}. Bets won't be marked as winning yet.`);
        }


        // 3. Получаем все ставки этого игрока за этот раунд
        const playerBetsInRound = await BetModel.find({ player: playerPubkeyStr, round: roundNumber })
                                        .sort({ timestamp: 1 }) // Сортируем по времени ставки (опционально)
                                        .lean();

        if (!playerBetsInRound || playerBetsInRound.length === 0) {
            console.log(`[API PlayerBets] No bets found for player ${playerPubkeyStr} in round ${roundNumber}.`);
            // Возвращаем пустой массив и статус claimed
            return res.json({ bets: [], alreadyClaimed });
        }

        // 4. Форматируем результат для КАЖДОЙ ставки
        const allPlayerBetsDetails = [];
        for (const betRecord of playerBetsInRound) {
             if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) continue; // Пропуск некорректных
             let betAmountBN;
             try { betAmountBN = new BN(betRecord.betAmount); } catch { continue; }

             // Определяем выигрыш, только если winningNum известно
             const isWinningBet = (winningNum !== null)
                                  ? isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum)
                                  : false; // Если раунд не завершен, ставка не выигрышная

            let payoutAmountBN = new BN(0);
            if (isWinningBet) { // Рассчитываем payout только если ставка выигрышная
                const multiplier = calculatePayoutMultiplier(betRecord.betType);
                payoutAmountBN = betAmountBN.mul(multiplier);
            }

            allPlayerBetsDetails.push({
                round: roundNumber,
                tokenMint: betRecord.tokenMint.toString(),
                betType: mapBetTypeEnumToString(betRecord.betType),
                numbers: betRecord.betNumbers || [],
                amountBet: betRecord.betAmount, // Сумма ставки (строка lamports)
                isWinning: isWinningBet, // true / false
                payoutAmount: payoutAmountBN.toString(), // Сумма выигрыша (строка lamports, "0" если не выиграла)
                signature: betRecord.signature,
                timestamp: new Date(betRecord.timestamp).getTime(), // Добавим timestamp ставки
            });
        }

        console.log(`[API PlayerBets] Found ${allPlayerBetsDetails.length} bets for player ${playerPubkeyStr} in round ${roundNumber}. Already claimed: ${alreadyClaimed}`);
        // Возвращаем массив ВСЕХ ставок и флаг, был ли клейм
        res.json({ bets: allPlayerBetsDetails, alreadyClaimed });

    } catch (error) {
        console.error(`[API PlayerBets] Error fetching bets for player ${playerPubkeyStr}, round ${roundNumber}:`, error);
        res.status(500).json({ error: 'Internal server error while fetching player bets' });
    }
});

// --- НОВЫЙ ЭНДПОИНТ: Проверка и данные для клейма последнего раунда игрока ---
app.get('/api/latest_bets', async (req, res) => { // <<< ИЗМЕНЕНО НАЗВАНИЕ
    const { player } = req.query;
    console.log(`%c[API LatestBets] Request for player: ${player}`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ

    // 1. Валидация Pubkey
    if (!player) {
        return res.status(400).json({ error: 'Player public key required' });
    }
    let playerPubkey;
    try {
        playerPubkey = new PublicKey(player); // Проверяем валидность
    } catch (e) {
        console.error(`[API LatestBets] Invalid player public key format: ${player}`); // <<< ИЗМЕНЕН ЛОГ
        return res.status(400).json({ error: 'Invalid player public key format' });
    }
    const playerPubkeyStr = playerPubkey.toBase58(); // Используем строку дальше

    try {
        // 2. Найти последний раунд с участием игрока
        const latestBet = await BetModel.findOne({ player: playerPubkeyStr })
                                       .sort({ round: -1 }) // Сортируем по убыванию раунда
                                       .lean();

        if (!latestBet) {
            console.log(`%c[API LatestBets] No bets found for player ${playerPubkeyStr}.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ
            return res.json({ claimable: false });
        }
        const playerLatestRound = latestBet.round;
        console.log(`%c[API LatestBets] Player ${playerPubkeyStr} latest participation round: ${playerLatestRound}.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ

        // 3. Проверить, завершен ли этот раунд
        const roundData = await RoundPayoutModel.findOne({ round: playerLatestRound }).lean();
        if (!roundData || roundData.winningNumber === undefined || roundData.winningNumber === null) {
            console.log(`%c[API LatestBets] Round ${playerLatestRound} is not completed or winning number not found.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ
            return res.json({ claimable: false });
        }
        const winningNum = roundData.winningNumber;
        console.log(`%c[API LatestBets] Round ${playerLatestRound} completed. Winning number: ${winningNum}.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ

        // 4. Проверить, забрал ли игрок выигрыш за этот раунд
        const existingClaim = await ClaimRecordModel.findOne({ player: playerPubkeyStr, round: playerLatestRound }).lean();
        if (existingClaim) {
            console.log(`%c[API LatestBets] Player ${playerPubkeyStr} already claimed winnings for round ${playerLatestRound}.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ
            return res.json({ claimable: false });
        }
        console.log(`%c[API LatestBets] Player ${playerPubkeyStr} has NOT claimed winnings for round ${playerLatestRound}. Calculating payout...`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ

        // 5. Рассчитать выигрыш за этот раунд
        const playerBetsInRound = await BetModel.find({ player: playerPubkeyStr, round: playerLatestRound }).lean();

        if (!playerBetsInRound || playerBetsInRound.length === 0) {
            console.warn(`%c[API LatestBets] Inconsistency: Found latest round ${playerLatestRound} but no bets for player ${playerPubkeyStr}.`, 'color: red;'); // <<< ИЗМЕНЕН ЛОГ
            return res.json({ claimable: false });
        }

        let totalPayoutBN = new BN(0);
        let roundTokenMint = null; // Узнаем минт из ставок
        const betsDetails = [];

        for (const betRecord of playerBetsInRound) {
            if (!roundTokenMint) roundTokenMint = betRecord.tokenMint?.toString(); // Берем минт из первой ставки
            if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) continue;
            let betAmountBN;
            try { betAmountBN = new BN(betRecord.betAmount); } catch { continue; }

            const isWinningBet = isBetWinner(betRecord.betType, betRecord.betNumbers || [], winningNum);
            let payoutAmountBN = new BN(0);
            if (isWinningBet) {
                const multiplier = calculatePayoutMultiplier(betRecord.betType);
                payoutAmountBN = betAmountBN.mul(multiplier);
                totalPayoutBN = totalPayoutBN.add(payoutAmountBN); // Суммируем общий выигрыш
            }

            betsDetails.push({
                round: playerLatestRound,
                tokenMint: betRecord.tokenMint?.toString(),
                betType: mapBetTypeEnumToString(betRecord.betType),
                numbers: betRecord.betNumbers || [],
                amountBet: betRecord.betAmount,
                isWinning: isWinningBet,
                payoutAmount: payoutAmountBN.toString(),
                signature: betRecord.signature,
                timestamp: new Date(betRecord.timestamp).getTime(),
            });
        }

         console.log(`%c[API LatestBets] Calculated total payout for player ${playerPubkeyStr} in round ${playerLatestRound}: ${totalPayoutBN.toString()} lamports.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ

        // 6. Вернуть результат
        if (totalPayoutBN.gtn(0)) { // gtn(0) - greater than zero
            // --- УБРАН ВЫЗОВ getTokenInfo И ПОЛЯ tokenSymbol, tokenDecimals ---
            const response = {
                claimable: true,
                roundNumber: playerLatestRound,
                tokenMint: roundTokenMint, // Оставляем минт, он нужен для клейма
                totalPayout: totalPayoutBN.toString(),
                bets: betsDetails
            };
            console.log(`%c[API LatestBets] Sending claimable response for player ${playerPubkeyStr}:`, 'color: green; font-weight: bold;', response); // <<< ИЗМЕНЕН ЛОГ
            return res.json(response);
        } else {
             console.log(`%c[API LatestBets] Player ${playerPubkeyStr} has no winnings in round ${playerLatestRound}.`, 'color: magenta;'); // <<< ИЗМЕНЕН ЛОГ
            return res.json({ claimable: false });
        }

    } catch (error) {
        console.error(`%c[API LatestBets] Error processing request for player ${playerPubkeyStr}:`, 'color: red;', error); // <<< ИЗМЕНЕН ЛОГ
        res.status(500).json({ error: 'Internal server error while checking latest bets' }); // <<< ИЗМЕНЕН ЛОГ
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
        'Passe', 'Columns', 'P12', 'M12', 'D12'
    ];
    if (enumValue >= 0 && enumValue < betTypeMapping.length) {
        return betTypeMapping[enumValue];
    }
    console.warn(`[mapBetType] Unknown bet_type enum: ${enumValue}`);
    return `Unknown (${enumValue})`; // Return gracefully for unknown types
}
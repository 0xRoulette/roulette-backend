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
    const borshCoder = new anchor.BorshCoder(idl);

    try {
        const subscriptionId = connection.onLogs(
            PROGRAM_ID,
            async (logsResult, context) => {
                console.log(`[onLogs Raw] Received logs for sig: ${signature}, err: ${err}, log count: ${logs?.length}`); // <<< ДОБАВЬ
                if (logs) {
                    logs.forEach((log, index) => console.log(`[onLogs Raw Log ${index}] ${log.substring(0, 150)}...`)); // <<< ДОБАВЬ (лог начала каждой строки)
                }
                const { signature, err, logs } = logsResult;
                const { slot } = context;

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
                                // --- RandomGenerated Event Handler ---
                                else if (event.name === 'RandomGenerated' && !isRandomGeneratedProcessed) {
                                    console.log(`[RandomGenerated] Processing event for signature ${signature}...`);
                                    const { round, initiator, winning_number, generation_time, slot, last_bettor } = event.data;
                                    const roundNum = Number(round);
                                    const winningNum = Number(winning_number);



                                    // --- Расчет выигрышей ---
                                    const betsForRound = await BetModel.find({ round: roundNum }).lean();
                                    // <<< ИСПРАВЛЕННЫЙ ЛОГ >>>
                                    console.log(`[RandomGenerated] Found ${betsForRound.length} bet records in DB for round ${roundNum}.`);
                                    const playerPayouts = new Map(); // Map<playerAddress, { totalPayout: BN, tokenMint: string }>

                                    if (betsForRound.length > 0) {
                                        for (const betRecord of betsForRound) {
                                            // Проверяем, что betAmount существует и это строка
                                            if (typeof betRecord.betAmount !== 'string' || betRecord.betAmount === null) {
                                                console.warn(`[RandomGenerated] Skipping bet record with invalid betAmount for player ${betRecord.player}, round ${roundNum}. Amount:`, betRecord.betAmount);
                                                continue;
                                            }

                                            let betAmountBN;
                                            try {
                                                betAmountBN = new BN(betRecord.betAmount); // Преобразуем строку в BN
                                            } catch (bnError) {
                                                console.error(`[RandomGenerated] Error converting betAmount '${betRecord.betAmount}' to BN for player ${betRecord.player}, round ${roundNum}. Skipping bet.`, bnError);
                                                continue; // Пропускаем эту ставку
                                            }


                                            if (isBetWinner(betRecord.betType, betRecord.betNumbers, winningNum)) {
                                                const multiplier = calculatePayoutMultiplier(betRecord.betType);
                                                const payoutForBet = betAmountBN.mul(multiplier);
                                                const playerAddress = betRecord.player;
                                                const tokenMint = betRecord.tokenMint;
                                                const currentData = playerPayouts.get(playerAddress) || { totalPayout: new BN(0), tokenMint: tokenMint };

                                                if (currentData.tokenMint !== tokenMint) {
                                                    console.error(`[FATAL] Player ${playerAddress} has winning bets with different mints (${currentData.tokenMint} and ${tokenMint}) in round ${roundNum}. Skipping payout calculation for this player.`);
                                                    playerPayouts.delete(playerAddress); // Удаляем игрока из выплат, чтобы избежать проблем
                                                    continue; // Переходим к следующей ставке
                                                }

                                                playerPayouts.set(playerAddress, {
                                                    totalPayout: currentData.totalPayout.add(payoutForBet),
                                                    tokenMint: tokenMint
                                                });
                                            }
                                        }
                                        console.log(`[RandomGenerated] Calculated payouts for ${playerPayouts.size} winners.`);
                                    } else {
                                        console.log(`[RandomGenerated] No bets found for round ${roundNum}. No payouts calculated.`);
                                    }
                                    // --- КОНЕЦ расчета выигрышей ---

                                    // --- Подготовка данных для сохранения и сокета ---
                                    const calculatedWinningsForSocket = {};
                                    const payoutsToSave = [];
                                    let tokenMintForRound = null; // Предполагаем один токен на раунд

                                    for (const [player, data] of playerPayouts.entries()) {
                                        calculatedWinningsForSocket[player] = {
                                            amount: data.totalPayout.toString(),
                                            tokenMint: data.tokenMint
                                        };
                                        payoutsToSave.push({
                                            address: player,
                                            amount: data.totalPayout.toString()
                                        });
                                        if (!tokenMintForRound) tokenMintForRound = data.tokenMint;
                                    }

                                    // --- Сохранение результатов раунда в RoundPayoutModel ---
                                    if (payoutsToSave.length > 0) { // Сохраняем, только если были победители
                                        try {
                                            await RoundPayoutModel.findOneAndUpdate(
                                                { round: roundNum, gameSessionPubkey: expectedGameSessionPubkey },
                                                {
                                                    round: roundNum,
                                                    gameSessionPubkey: expectedGameSessionPubkey,
                                                    winningNumber: winningNum,
                                                    payouts: payoutsToSave,
                                                    // Можно добавить tokenMint: tokenMintForRound, если нужно
                                                },
                                                { upsert: true, new: true, setDefaultsOnInsert: true }
                                            );
                                            console.log(`[RandomGenerated] Saved/Updated RoundPayout data for round ${roundNum}.`);
                                        } catch (payoutDbError) {
                                            console.error(`[RandomGenerated] Error saving RoundPayout data for round ${roundNum}:`, payoutDbError);
                                        }
                                    } else {
                                        console.log(`[RandomGenerated] No payouts to save for round ${roundNum}.`);
                                        // Можно создать запись без выплат, если нужно зафиксировать сам раунд
                                        try {
                                            await RoundPayoutModel.findOneAndUpdate(
                                                { round: roundNum, gameSessionPubkey: expectedGameSessionPubkey },
                                                {
                                                    round: roundNum,
                                                    gameSessionPubkey: expectedGameSessionPubkey,
                                                    winningNumber: winningNum,
                                                    payouts: [], // Пустой массив выплат
                                                },
                                                { upsert: true, new: true, setDefaultsOnInsert: true }
                                            );
                                            console.log(`[RandomGenerated] Saved empty RoundPayout data for round ${roundNum}.`);
                                        } catch (payoutDbError) {
                                            console.error(`[RandomGenerated] Error saving empty RoundPayout data for round ${roundNum}:`, payoutDbError);
                                        }
                                    }
                                    // --- КОНЕЦ Сохранения ---

                                    // --- Отправка по WebSocket ---
                                    const eventForSocket = {
                                        round: roundNum,
                                        winningNumber: winningNum,
                                        timestamp: Number(generation_time) * 1000,
                                        generationSignature: signature,
                                        winners: calculatedWinningsForSocket,
                                        initiator: initiator.toBase58(),
                                        slot: Number(slot),
                                        lastBettor: last_bettor.toBase58()
                                    };
                                    io.emit('winningsCalculated', eventForSocket);
                                    console.log(`[RandomGenerated] Emitted 'winningsCalculated' event for round ${roundNum}.`);
                                    isRandomGeneratedProcessed = true;
                                }
                                // --- WinningsClaimed Event Handler ---
                                else if (event.name === 'WinningsClaimed' && !isWinningsClaimedProcessed) {
                                    console.log(`[WinningsClaimed] Processing event for signature ${signature}...`);
                                    const { round, player, token_mint, amount, timestamp } = event.data;
                                    const eventForSocket = {
                                        round: Number(round),
                                        player: player.toBase58(),
                                        tokenMint: token_mint.toBase58(),
                                        amount: amount.toString(),
                                        timestamp: Number(timestamp) * 1000, // В миллисекундах
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

        console.log(`[onLogs] Successfully subscribed to logs. Subscription ID: ${subscriptionId}`);

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
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
const PROGRAM_ID = new PublicKey('9ZgFwUaAu1DHYMWpyKFguqmHi5Hb8BAyzdcvb1q7frtN');
const idl = require('./roulette_game.json'); // Ensure this is the latest IDL
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
const program = new anchor.Program(idl, PROGRAM_ID, provider);

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
                const { signature, err, logs } = logsResult;
                const { slot } = context;

                if (err) {
                    console.error(`[onLogs] Error in logs subscription for signature ${signature}:`, err);
                    return;
                }
                // Prevent processing the same transaction multiple times if logs arrive duplicated
                if (processingSignatures.has(signature)) {
                    return;
                }
                processingSignatures.add(signature);
                console.log(`[onLogs] Processing signature: ${signature} at slot ${slot}`);

                try {
                    // Flags to track if an event type has already been processed within this transaction's logs
                    let isBetsPlacedProcessed = false;
                    let isRandomGeneratedProcessed = false;
                    let isWinningsClaimedProcessed = false;

                    // --- Event Decoding Loop ---
                    for (const log of logs) {
                        const logPrefix = "Program data: "; // Anchor event logs start with this prefix
                        if (log.startsWith(logPrefix)) {
                            try {
                                const base64Data = log.substring(logPrefix.length);
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                const event = borshCoder.events.decode(eventDataBuffer); // Decode the event using the IDL

                                if (!event) continue; // Skip if decoding fails or it's not a recognized event

                                // --- BetsPlaced Event Handler ---
                                if (event.name === 'BetsPlaced' && !isBetsPlacedProcessed) {
                                    console.log(`[BetsPlaced] Processing event for signature ${signature}...`);
                                    const { player, token_mint, round, bets, timestamp } = event.data;

                                    let savedCount = 0;
                                    const savedBetDetailsForSocket = [];
                                    // Process each bet within the event (although currently contract emits one bet per event)
                                    const betSavePromises = bets.map(async (betDetail) => {
                                        const betDataToSave = {
                                            player: player.toBase58(),
                                            tokenMint: token_mint.toBase58(),
                                            round: Number(round),
                                            betAmount: betDetail.amount.toString(),
                                            betType: betDetail.bet_type,
                                            betNumbers: betDetail.numbers,
                                            timestamp: new Date(Number(timestamp) * 1000),
                                            signature: signature
                                        };
                                        try {
                                            // Use findOneAndUpdate with upsert=true for idempotency
                                            // Unique key includes signature and bet details to handle potential retries/duplicates
                                            await BetModel.findOneAndUpdate(
                                                { signature: signature, player: betDataToSave.player, round: betDataToSave.round, betType: betDataToSave.betType, 'betNumbers': betDataToSave.betNumbers },
                                                betDataToSave,
                                                { upsert: true, new: true }
                                            );
                                            savedCount++;
                                            savedBetDetailsForSocket.push({
                                                amount: betDataToSave.betAmount,
                                                bet_type: betDataToSave.betType, // Send numeric type
                                                numbers: betDataToSave.betNumbers
                                            });
                                        } catch (dbError) {
                                            console.error(`[BetsPlaced] Error saving bet detail to DB for signature ${signature}:`, dbError);
                                        }
                                    });
                                    await Promise.all(betSavePromises);
                                    console.log(`[BetsPlaced] DB Save/Upsert Completed for ${savedCount} bets.`);

                                    // Emit event to frontend clients via Socket.IO
                                    if (savedCount > 0) {
                                        const eventForSocket = {
                                            player: player.toBase58(),
                                            token_mint: token_mint.toBase58(),
                                            round: round.toString(),
                                            timestamp: timestamp.toString(),
                                            bets: savedBetDetailsForSocket, // Array containing details of the bet(s) placed
                                            signature: signature
                                        };
                                        io.emit('newBets', eventForSocket);
                                        console.log(`[BetsPlaced] Emitted 'newBets' event via Socket.IO.`);
                                    }
                                    isBetsPlacedProcessed = true; // Mark as processed for this transaction
                                }
                                // --- RandomGenerated Event Handler ---
                                else if (event.name === 'RandomGenerated' && !isRandomGeneratedProcessed) {
                                    console.log(`[RandomGenerated] Processing event for signature ${signature}...`);
                                    const { round, winning_number, generation_time } = event.data; // Removed unused last_bettor, slot
                                    const roundNum = Number(round);
                                    const winningNum = Number(winning_number);

                                    console.log(`[RandomGenerated] Round: ${roundNum}, Winning Number: ${winningNum}`);

                                    // 1. Fetch all bets for this round from the database
                                    const betsForRound = await BetModel.find({ round: roundNum });
                                    console.log(`[RandomGenerated] Found ${betsForRound.length} bet records in DB for round ${roundNum}.`);

                                    // 2. Calculate winnings based on fetched bets and winning number
                                    const playerPayouts = new Map(); // <playerAddress, { totalPayout: BN, tokenMint: string }>
                                    if (betsForRound.length > 0) {
                                        for (const betRecord of betsForRound) {
                                            const betAmount = new BN(betRecord.betAmount);
                                            if (isBetWinner(betRecord.betType, betRecord.betNumbers, winningNum)) { // Check if the bet won
                                                const multiplier = calculatePayoutMultiplier(betRecord.betType); // Get the payout multiplier
                                                const payoutForBet = betAmount.mul(multiplier);
                                                const playerAddress = betRecord.player;
                                                const tokenMint = betRecord.tokenMint;

                                                const currentData = playerPayouts.get(playerAddress) || { totalPayout: new BN(0), tokenMint: tokenMint };
                                                // Sanity check: ensure winning bets for a player used the same mint
                                                if (currentData.tokenMint !== tokenMint) {
                                                    console.error(`[FATAL] Player ${playerAddress} has winning bets with different mints (${currentData.tokenMint} and ${tokenMint}) in round ${roundNum}. Skipping this bet calculation.`);
                                                    continue;
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

                                    // 3. Prepare payout data for Socket.IO emission
                                    const calculatedWinnings = {};
                                    for (const [player, data] of playerPayouts.entries()) {
                                        calculatedWinnings[player] = {
                                            amount: data.totalPayout.toString(), // Send amount as string
                                            tokenMint: data.tokenMint
                                        };
                                    }

                                    // 4. Emit event with calculated winnings to frontend clients
                                    const eventForSocket = {
                                        round: roundNum,
                                        winningNumber: winningNum,
                                        timestamp: Number(generation_time), // Use timestamp from event
                                        generationSignature: signature,
                                        winners: calculatedWinnings // Object: { playerAddress: { amount: "...", tokenMint: "..." } }
                                    };
                                    io.emit('winningsCalculated', eventForSocket);
                                    console.log(`[RandomGenerated] Emitted 'winningsCalculated' event for round ${roundNum} with ${Object.keys(calculatedWinnings).length} winners.`);

                                    isRandomGeneratedProcessed = true; // Mark as processed for this transaction
                                }
                                // --- WinningsClaimed Event Handler ---
                                else if (event.name === 'WinningsClaimed' && !isWinningsClaimedProcessed) {
                                    console.log(`[WinningsClaimed] Processing event for signature ${signature}...`);
                                    const { round, player, token_mint, amount, timestamp } = event.data;

                                    // Prepare data for Socket.IO emission
                                    const eventForSocket = {
                                        round: Number(round),
                                        player: player.toBase58(),
                                        tokenMint: token_mint.toBase58(),
                                        amount: amount.toString(), // Send amount as string
                                        timestamp: Number(timestamp),
                                        claimSignature: signature
                                    };
                                    // Emit event to frontend clients
                                    io.emit('winningsClaimed', eventForSocket);
                                    console.log(`[WinningsClaimed] Emitted 'winningsClaimed' for player ${eventForSocket.player} round ${eventForSocket.round}.`);

                                    // TODO (Optional): Save claim information to a 'ClaimHistory' collection in the DB
                                    // try {
                                    //   await ClaimHistoryModel.create(eventForSocket);
                                    //   console.log(`[WinningsClaimed] Saved claim to DB.`);
                                    // } catch (dbError) {
                                    //   console.error(`[WinningsClaimed] Error saving claim to DB:`, dbError);
                                    // }
                                    isWinningsClaimedProcessed = true; // Mark as processed for this transaction
                                }

                            } catch (decodeError) {
                                console.error(`[EventDecode] Error decoding log for signature ${signature}:`, decodeError);
                            }
                        } // End if log.startsWith(logPrefix)
                    } // End for loop over logs

                } catch (processingError) {
                    console.error(`[onLogs] Error processing signature ${signature}:`, processingError);
                } finally {
                    // Remove signature from the processing set once done
                    processingSignatures.delete(signature);
                }

            },
            'confirmed' // Process logs with 'confirmed' commitment
        );

        console.log(`[onLogs] Successfully subscribed to logs. Subscription ID: ${subscriptionId}`);

    } catch (error) {
        console.error("[onLogs] Failed to subscribe to logs:", error);
    }
} // End listenToEvents

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
        // Fetch bets from DB, sort by timestamp descending
        const betsFromDb = await BetModel.find({ round: roundNumber }).sort({ timestamp: -1 }).lean();

        if (!betsFromDb || betsFromDb.length === 0) {
            console.log(`[API Bets] No bets found for round ${roundNumber}.`);
            return res.json([]); // Return empty array if no bets found
        }
        console.log(`[API Bets] Found ${betsFromDb.length} bet records for round ${roundNumber}.`);

        // Map DB data to response format, converting bet type enum to string
        const responseData = betsFromDb.map(bet => ({
            player: bet.player.toString(),
            round: bet.round,
            tokenMint: bet.tokenMint.toString(),
            timestamp: new Date(bet.timestamp).getTime(), // Send timestamp as number (milliseconds)
            amount: bet.betAmount, // Send amount as string (lamports)
            betType: mapBetTypeEnumToString(bet.betType), // Map enum to string
            numbers: bet.betNumbers || [],
            signature: bet.signature
            // isMyBet: bet.player.toString() === 'SOME_ADDRESS' // Potential future addition
        }));

        console.log(`[API Bets] Sending flat list of bets for round ${roundNumber}.`);
        res.json(responseData);

    } catch (error) {
        console.error(`[API Bets] Error fetching bets for round ${roundNumber}:`, error);
        res.status(500).json({ error: 'Internal server error while fetching bets' });
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
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const fs = require('fs')
const cors = require('cors');
const BN = require('bn.js');
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js'); // Solana web3 до использования
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');

// --- Конфигурация ---
const { QUICKNODE_RPC, MONGO_URI, QUICKNODE_WSS } = require('./config');

// --- Инициализация Solana ---
const PROGRAM_ID = new PublicKey('5c7NSFehUoWQXtXSzMMC9RmiZ1YTpPt5ubXLC5Xd52JX');
const idl = require('./roulette_game.json');
const connection = new Connection(QUICKNODE_RPC, {
    wsEndpoint: QUICKNODE_WSS,
    commitment: 'confirmed'
});
const walletPath = './id.json';
const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
const ownerKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
const ownerWallet = new anchor.Wallet(ownerKeypair);
const provider = new anchor.AnchorProvider(connection, ownerWallet, { commitment: 'confirmed' });

// --- Инициализация Anchor Program (теперь все переменные объявлены) ---
const program = new anchor.Program(idl, PROGRAM_ID, provider);

// --- Модели Базы Данных ---
const BetModel = require('./models/Bet');
const RoundPayoutModel = require('./models/RoundPayout');

// --- Другие Константы ---
const BET_TYPE_STRAIGHT = 0;
const BET_TYPE_SPLIT = 1;
const BET_TYPE_CORNER = 2;
const BET_TYPE_STREET = 3;
const BET_TYPE_SIX_LINE = 4;
const BET_TYPE_FIRST_FOUR = 5; // На 0, 1, 2, 3
const BET_TYPE_RED = 6;
const BET_TYPE_BLACK = 7;
const BET_TYPE_EVEN = 8;
const BET_TYPE_ODD = 9;
const BET_TYPE_MANQUE = 10; // 1-18
const BET_TYPE_PASSE = 11; // 19-36
const BET_TYPE_COLUMN = 12; // Исправлено с Columns
const BET_TYPE_P12 = 13; // 1-12
const BET_TYPE_M12 = 14; // 13-24
const BET_TYPE_D12 = 15; // 25-36
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const processingSignatures = new Set(); // Множество для отслеживания обрабатываемых сигнатур

// --- Настройка Express и Socket.IO ---
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
const PORT = process.env.PORT || 3001;

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
    console.log("Attaching event listener now...");
    listenToBets();
});



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

                if (processingSignatures.has(signature)) {
                    // console.log(`[onLogs] Signature ${signature} is already being processed. Skipping.`); // Можно раскомментировать для отладки
                    return;
                }
                processingSignatures.add(signature);
                console.log(`[onLogs] Processing signature: ${signature} at slot ${slot}`);

                try {
                    const existingBet = await BetModel.findOne({ signature: signature });
                    let isBetsPlacedProcessed = !!existingBet;

                    let decodedBetsPlaced = null;
                    let decodedRandomGenerated = null;

                    // Декодирование событий из логов
                    for (const log of logs) {
                        const logPrefix = "Program data: ";
                        if (log.startsWith(logPrefix)) {
                            try {
                                const base64Data = log.substring(logPrefix.length);
                                const eventDataBuffer = anchor.utils.bytes.base64.decode(base64Data);
                                const event = borshCoder.events.decode(eventDataBuffer);

                                if (event) {
                                    // console.log(`[EventDecode] Decoded event '${event.name}' for signature ${signature}.`); // Можно раскомментировать
                                    if (event.name === 'BetsPlaced') {
                                        decodedBetsPlaced = event;
                                    } else if (event.name === 'RandomGenerated') {
                                        decodedRandomGenerated = event;
                                    }
                                    // Можно добавить обработку PayoutRootSubmitted и PayoutClaimed, если нужно что-то логировать/эмитить
                                }
                            } catch (decodeError) {
                                // console.error(`[EventDecode] Error decoding log entry for signature ${signature}. Log: "${log}". Error:`, decodeError); // Можно раскомментировать
                            }
                        }
                    } // Конец цикла по логам

                    // --- Обработка BetsPlaced (Сохранение ставок) ---
                    if (decodedBetsPlaced && !isBetsPlacedProcessed) {
                        console.log(`[BetsPlaced] Processing event for signature ${signature}...`);
                        const event = decodedBetsPlaced;
                        const { player, token_mint, round, bets, timestamp } = event.data;

                        // Сохраняем каждую ставку из события в БД
                        let savedCount = 0;
                        const savedBetDetailsForSocket = [];

                        const betSavePromises = bets.map(async (betDetail) => {
                            const betDataToSave = {
                                player: player.toBase58(),
                                tokenMint: token_mint.toBase58(),
                                round: Number(round),
                                betAmount: betDetail.amount.toString(),
                                betType: betDetail.bet_type,
                                betNumbers: betDetail.numbers, // Контракт отдает [u8; 4]
                                timestamp: new Date(Number(timestamp) * 1000),
                                signature: signature // Сохраняем сигнатуру транзакции
                            };
                            try {
                                // Используем findOneAndUpdate с upsert=true для идемпотентности на случай повторов
                                await BetModel.findOneAndUpdate(
                                    { signature: signature, player: betDataToSave.player, round: betDataToSave.round, betType: betDataToSave.betType, 'betNumbers': betDataToSave.betNumbers }, // Уникальный ключ ставки в транзакции
                                    betDataToSave,
                                    { upsert: true, new: true }
                                );
                                savedCount++;
                                savedBetDetailsForSocket.push({
                                    amount: betDataToSave.betAmount,
                                    bet_type: betDataToSave.betType,
                                    numbers: betDataToSave.betNumbers
                                });
                            } catch (dbError) {
                                console.error(`[BetsPlaced] Error saving bet detail to DB for signature ${signature}:`, dbError);
                            }
                        });
                        await Promise.all(betSavePromises);
                        console.log(`[BetsPlaced] DB Save/Upsert Completed for ${savedCount} bets.`);

                        // Отправляем событие в Socket.IO, если были сохранены ставки
                        if (savedCount > 0) {
                            const eventForSocket = {
                                player: player.to_base58(), // Используем to_base58 для PublicKey
                                token_mint: token_mint.toBase58(),
                                round: round.toString(),
                                timestamp: timestamp.toString(),
                                bets: savedBetDetailsForSocket,
                                signature: signature
                            };
                            io.emit('newBets', eventForSocket); // <<< ЭМИТИМ событие для фронтенда
                            console.log(`[BetsPlaced] Emitted 'newBets' event via Socket.IO.`);
                        }
                        isBetsPlacedProcessed = true;
                    } else if (decodedBetsPlaced && isBetsPlacedProcessed) {
                        // console.log(`[BetsPlaced] Signature ${signature} already processed (found in DB). Skipping BetsPlaced event.`);
                    }

                    // --- Обработка RandomGenerated (Расчет выигрышей, Merkle Tree, Отправка корня) ---
                    if (decodedRandomGenerated) {
                        console.log(`[RandomGenerated] Processing event for signature ${signature}...`);
                        const event = decodedRandomGenerated;
                        // Извлекаем данные из события RandomGenerated контракта
                        const { round, winning_number, generation_time } = event.data;
                        const roundNum = Number(round);
                        const winningNum = Number(winning_number);

                        console.log(`[RandomGenerated] Round: ${roundNum}, Winning Number: ${winningNum}`);

                        // 1. Проверка, не обработан ли уже раунд
                        const existingRoundPayout = await RoundPayoutModel.findOne({ round: roundNum });
                        if (existingRoundPayout) {
                            console.warn(`[RandomGenerated] Round ${roundNum} payout already processed/stored. Skipping.`);
                            return; // Выходим, если раунд уже обработан
                        }

                        // 2. Получение всех ставок раунда из БД
                        const betsForRound = await BetModel.find({ round: roundNum });
                        console.log(`[RandomGenerated] Found ${betsForRound.length} bet records in DB for round ${roundNum}.`);

                        let merkleTree = null;
                        let payoutRootHex = null;
                        let payoutLeavesData = [];
                        let rootBuffer = Buffer.alloc(32); // Корень по умолчанию (для пустого раунда)

                        if (betsForRound.length > 0) {
                            // 3. Расчет выигрышей для каждого игрока
                            const playerPayouts = new Map(); // <playerAddress, totalPayoutBN>
                            for (const betRecord of betsForRound) {
                                const betAmount = new BN(betRecord.betAmount);
                                if (isBetWinner(betRecord.betType, betRecord.betNumbers, winningNum)) {
                                    const multiplier = calculatePayoutMultiplier(betRecord.betType);
                                    const payoutForBet = betAmount.mul(multiplier);
                                    const playerAddress = betRecord.player;
                                    const currentTotal = playerPayouts.get(playerAddress) || new BN(0);
                                    playerPayouts.set(playerAddress, currentTotal.add(payoutForBet));
                                }
                            }
                            console.log(`[RandomGenerated] Calculated payouts for ${playerPayouts.size} winners.`);

                            // 4. Подготовка данных и построение Merkle Tree
                            payoutLeavesData = Array.from(playerPayouts.entries()).map(([address, amount]) => ({
                                address: address,
                                amount: amount // Оставляем BN
                            }));

                            try {
                                console.log("[RandomGenerated] Building Merkle Tree...");
                                const leaves = payoutLeavesData.map(payout => {
                                    const addressBuffer = new PublicKey(payout.address).toBuffer();
                                    const amountBuffer = payout.amount.toArrayLike(Buffer, 'le', 8); // u64 little-endian
                                    const packedData = Buffer.concat([addressBuffer, amountBuffer]);
                                    return keccak256(packedData);
                                });

                                if (leaves.length > 0) {
                                    merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
                                    rootBuffer = merkleTree.getRoot(); // Получаем Buffer корня
                                }
                                // Если leaves пустой (никто не выиграл), rootBuffer останется пустым (Buffer.alloc(32))

                                payoutRootHex = '0x' + rootBuffer.toString('hex');
                                console.log(`[RandomGenerated] Merkle Tree built. Root: ${payoutRootHex}`);

                            } catch (merkleError) {
                                console.error(`[RandomGenerated] Error building Merkle Tree for round ${roundNum}:`, merkleError);
                                payoutRootHex = null; // Сбрасываем корень при ошибке
                            }
                        } else {
                            console.log(`[RandomGenerated] No bets found for round ${roundNum}. Using empty Merkle Root.`);
                            payoutRootHex = '0x' + rootBuffer.toString('hex'); // Корень для пустого раунда
                        }

                        // 5. Вызов ончейн инструкции submit_payout_root
                        let submitTxSignature = null;
                        let submitError = null;
                        if (payoutRootHex) {
                            console.log(`[RandomGenerated] Attempting to submit payout root ${payoutRootHex} for round ${roundNum}...`);
                            try {
                                // Находим PDA для RoundPayoutInfo (куда будет записан корень)
                                const [roundPayoutInfoPDA, _payoutBump] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("payout_info"), new BN(roundNum).toArrayLike(Buffer, 'le', 8)],
                                    program.programId
                                );
                                // Находим PDA для GameSession (нужен для проверок в контракте)
                                const [gameSessionPDA, _sessionBump] = PublicKey.findProgramAddressSync(
                                    [Buffer.from("game_session")], // Сиды для game_session (без номера раунда)
                                    program.programId
                                );

                                console.log(`[SubmitRoot] Using GameSession PDA: ${gameSessionPDA.toBase58()}`);
                                console.log(`[SubmitRoot] Using RoundPayoutInfo PDA: ${roundPayoutInfoPDA.toBase58()}`);

                                submitTxSignature = await program.methods
                                    .submitPayoutRoot(new BN(roundNum), [...rootBuffer]) // rootBuffer как массив байт
                                    .accounts({
                                        authority: ownerWallet.publicKey, // Авторитет бэкенда
                                        gameSession: gameSessionPDA,
                                        roundPayoutInfo: roundPayoutInfoPDA,
                                        systemProgram: anchor.web3.SystemProgram.programId,
                                        // rent: anchor.web3.SYSVAR_RENT_PUBKEY, // Rent неявно используется Anchor при init
                                    })
                                    // .signers([ownerKeypair]) // Provider сам подписывает, если он authority
                                    .rpc({ commitment: 'confirmed', skipPreflight: true }); // Пропускаем preflight для init

                                console.log(`[RandomGenerated] Successfully submitted payout root for round ${roundNum}. Tx: ${submitTxSignature}`);

                            } catch (error) {
                                console.error(`[RandomGenerated] Error submitting payout root for round ${roundNum}:`, error);
                                submitError = error.toString();
                            }
                        } else {
                            console.warn(`[RandomGenerated] Skipping on-chain submission for round ${roundNum} due to Merkle build errors.`);
                        }

                        // 6. Сохранение данных о раунде (корень, выплаты) в БД
                        if (payoutRootHex) {
                            console.log("[RandomGenerated] Saving payout info to DB for round", roundNum);
                            try {
                                const payoutDataToSave = payoutLeavesData.map(p => ({
                                    address: p.address,
                                    amount: p.amount.toString() // Сохраняем как строку
                                }));

                                await RoundPayoutModel.create({
                                    round: roundNum,
                                    payoutRootHex: payoutRootHex,
                                    payouts: payoutDataToSave,
                                    winningNumber: winningNum,
                                    onChainSubmitTx: submitTxSignature,
                                    onChainSubmitError: submitError // Сохраняем ошибку, если была
                                });
                                console.log(`[RandomGenerated] Successfully saved payout data for round ${roundNum} to DB.`);

                                // <<< ЭМИТИМ событие о завершении раунда и доступности выплат (опционально)
                                io.emit('roundCompleted', {
                                    round: roundNum,
                                    winningNumber: winningNum,
                                    payoutRoot: payoutRootHex,
                                    submitTx: submitTxSignature,
                                    timestamp: Math.floor(Date.now() / 1000)
                                });
                                console.log(`[RandomGenerated] Emitted 'roundCompleted' event via Socket.IO.`);

                            } catch (dbError) {
                                console.error(`[RandomGenerated] Error saving payout data for round ${roundNum} to DB:`, dbError);
                            }
                        } else {
                            console.warn(`[RandomGenerated] Skipping DB save for round ${roundNum} because payout root was not generated.`);
                        }
                    } // Конец обработки RandomGenerated

                } catch (processingError) {
                    console.error(`[onLogs] Error processing signature ${signature}:`, processingError);
                } finally {
                    processingSignatures.delete(signature);
                    // console.log(`[onLogs] Finished processing signature ${signature}.`); // Можно раскомментировать
                }

            }, // Конец async колбэка onLogs
            'confirmed'
        );

        console.log(`[onLogs] Successfully subscribed to logs. Subscription ID: ${subscriptionId}`);

    } catch (error) {
        console.error("[onLogs] Failed to subscribe to logs:", error);
    }
} // Конец listenToBets



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

app.get('/api/payout-proof', async (req, res) => {
    const { round, player } = req.query;

    if (!round || !player || isNaN(parseInt(round))) {
        return res.status(400).json({ error: 'Missing or invalid parameters: round (number) and player (address) are required.' });
    }

    const roundNum = parseInt(round);
    const playerAddress = player;

    console.log(`[API Proof] Request for player ${playerAddress} in round ${roundNum}`);

    try {
        // 1. Найти данные о раунде в БД
        const roundData = await RoundPayoutModel.findOne({ round: roundNum }).lean(); // Используем lean для производительности

        if (!roundData) {
            console.log(`[API Proof] Round ${roundNum} data not found in DB.`);
            return res.status(404).json({ error: `Payout data for round ${roundNum} not found.` });
        }

        // 2. Найти конкретную выплату для игрока
        const playerPayout = roundData.payouts.find(p => p.address === playerAddress);

        if (!playerPayout) {
            console.log(`[API Proof] No payout found for player ${playerAddress} in round ${roundNum}.`);
            return res.status(404).json({ error: `No winning payout found for player ${playerAddress} in round ${roundNum}.` });
        }

        // 3. Восстановить дерево и сгенерировать proof
        console.log(`[API Proof] Found payout for ${playerAddress}: ${playerPayout.amount}. Generating proof...`);

        // Воссоздаем листья из сохраненных данных
        const leaves = roundData.payouts.map(p => {
            const addressBuffer = new PublicKey(p.address).toBuffer();
            const amountBuffer = new BN(p.amount).toArrayLike(Buffer, 'le', 8); // Восстанавливаем BN из строки
            const packedData = Buffer.concat([addressBuffer, amountBuffer]);
            return keccak256(packedData);
        });

        // Создаем дерево (с теми же опциями!)
        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

        // Создаем лист для запрашиваемого игрока
        const leafToProve = keccak256(Buffer.concat([
            new PublicKey(playerPayout.address).toBuffer(),
            new BN(playerPayout.amount).toArrayLike(Buffer, 'le', 8)
        ]));

        // Генерируем proof
        const proof = tree.getHexProof(leafToProve).map(p => p.slice(2)); // Убираем '0x' из каждого элемента proof

        // Проверяем корень (на всякий случай)
        const calculatedRoot = tree.getHexRoot();
        if (calculatedRoot !== roundData.payoutRootHex) {
            console.error(`[API Proof] FATAL: Calculated Merkle root ${calculatedRoot} does not match stored root ${roundData.payoutRootHex} for round ${roundNum}!`);
            return res.status(500).json({ error: 'Internal server error: Merkle root mismatch.' });
        }

        console.log(`[API Proof] Proof generated successfully for ${playerAddress} in round ${roundNum}.`);

        // 4. Отправить ответ
        res.json({
            round: roundNum,
            player: playerAddress,
            amount: playerPayout.amount, // Сумма выплаты (строка)
            proof: proof // Массив хэшей (строки без '0x')
        });

    } catch (error) {
        console.error(`[API Proof] Error generating proof for player ${playerAddress} round ${roundNum}:`, error);
        res.status(500).json({ error: 'Internal server error while generating proof.' });
    }
});

function calculatePayoutMultiplier(betType) {
    switch (betType) {
        case BET_TYPE_STRAIGHT: return new BN(36);
        case BET_TYPE_SPLIT: return new BN(18);
        case BET_TYPE_CORNER: return new BN(9);
        case BET_TYPE_STREET: return new BN(12);
        case BET_TYPE_SIX_LINE: return new BN(6);
        case BET_TYPE_FIRST_FOUR: return new BN(9); // Уточни множитель в контракте, если нужно
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
        default: return new BN(0);
    }
}

function isBetWinner(betType, numbers, winningNumber) {
    winningNumber = Number(winningNumber); // Убедимся, что это число
    numbers = numbers.map(n => Number(n)); // И числа в массиве тоже

    switch (betType) {
        case BET_TYPE_STRAIGHT: return numbers[0] === winningNumber;
        case BET_TYPE_SPLIT: return numbers[0] === winningNumber || numbers[1] === winningNumber;
        case BET_TYPE_CORNER:
            const topLeft = numbers[0];
            // Проверка на валидность угла (не выходит за границы)
            if (topLeft % 3 === 0 || topLeft > 34 || topLeft === 0) return false; // Угол не может начинаться с правого края или последних рядов
            const cornerNumbers = [topLeft, topLeft + 1, topLeft + 3, topLeft + 4];
            return cornerNumbers.includes(winningNumber);
        case BET_TYPE_STREET:
            // Номер улицы (1-12). Число в numbers[0] должно быть первым числом улицы (1, 4, 7...)
            const startStreet = numbers[0];
            if ((startStreet - 1) % 3 !== 0 || startStreet > 34 || startStreet < 1) return false;
            return winningNumber >= startStreet && winningNumber < startStreet + 3 && winningNumber !== 0;
        case BET_TYPE_SIX_LINE:
            // Номер линии (1-11). Число в numbers[0] должно быть первым числом линии (1, 4, 7...)
            const startSixLine = numbers[0];
            if ((startSixLine - 1) % 3 !== 0 || startSixLine > 31 || startSixLine < 1) return false;
            return winningNumber >= startSixLine && winningNumber < startSixLine + 6 && winningNumber !== 0;
        case BET_TYPE_FIRST_FOUR: return [0, 1, 2, 3].includes(winningNumber);
        case BET_TYPE_RED: return RED_NUMBERS.has(winningNumber);
        case BET_TYPE_BLACK: return winningNumber !== 0 && !RED_NUMBERS.has(winningNumber);
        case BET_TYPE_EVEN: return winningNumber !== 0 && winningNumber % 2 === 0;
        case BET_TYPE_ODD: return winningNumber !== 0 && winningNumber % 2 === 1;
        case BET_TYPE_MANQUE: return winningNumber >= 1 && winningNumber <= 18;
        case BET_TYPE_PASSE: return winningNumber >= 19 && winningNumber <= 36;
        case BET_TYPE_COLUMN:
            const column = numbers[0]; // Номер колонки (1, 2 или 3)
            if (column < 1 || column > 3) return false;
            return winningNumber !== 0 && winningNumber % 3 === (column % 3);
        case BET_TYPE_P12: return winningNumber >= 1 && winningNumber <= 12;
        case BET_TYPE_M12: return winningNumber >= 13 && winningNumber <= 24;
        case BET_TYPE_D12: return winningNumber >= 25 && winningNumber <= 36;
        default: return false;
    }
}

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
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
console.log("DEBUG: @solana/web3.js loaded");
const fs = require('fs');
console.log("DEBUG: fs loaded");
const borsh = require('@coral-xyz/borsh');
console.log("DEBUG: @coral-xyz/borsh loaded");

// --- Сначала загружаем IDL ---
const IDL_PATH = './roulette_game.json'; // Путь к IDL файлу программы
let idl;
try {
    console.log("DEBUG: Trying to load IDL...");
    idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    console.log('IDL loaded successfully.');
} catch (err) {
    console.error(`Failed to load IDL from ${IDL_PATH}:`, err);
    process.exit(1);
}

// --- Конфигурация ---
const RPC_URL = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(idl.address);
// Используем тот же ключ и как авторитет/плательщик, и как "игрок" для теста
const PLAYER_KEYPAIR_PATH = process.env.HOME + '/.config/solana/id.json';
console.log("DEBUG: Configuration set");

const connection = new Connection(RPC_URL, 'confirmed');
console.log("DEBUG: Connection created");

let playerSigner; // Переменная для ключа игрока
try {
    console.log(`DEBUG: Trying to load player keypair from ${PLAYER_KEYPAIR_PATH}...`);
    const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(PLAYER_KEYPAIR_PATH)));
    playerSigner = Keypair.fromSecretKey(keypairData);
    console.log('Player Keypair loaded:', playerSigner.publicKey.toBase58());
} catch (err) {
    console.error(`Failed to load player keypair from ${PLAYER_KEYPAIR_PATH}:`, err);
    process.exit(1);
}

function findInstructionDiscriminator(idl, instructionName) {
    console.log(`DEBUG: Finding discriminator for ${instructionName}...`);
    const instruction = idl.instructions.find(ix => ix.name === instructionName);
    if (!instruction || !instruction.discriminator) {
        throw new Error(`Discriminator for instruction "${instructionName}" not found in IDL`);
    }
    if (Array.isArray(instruction.discriminator)) {
        return Buffer.from(instruction.discriminator);
    } else {
        console.warn(`Unexpected discriminator format for ${instructionName}, check IDL generation.`);
        try {
            return Buffer.from(instruction.discriminator, 'base64');
        } catch (e) {
            throw new Error(`Failed to decode discriminator for ${instructionName}`);
        }
    }
}

async function initializePlayerBetsAccount() {
    console.log("DEBUG: Entering initializePlayerBetsAccount...");
    let transactionSignature;

    try {
        // 1. Находим PDA для game_session
        console.log("DEBUG: Finding Program Address for game_session...");
        const [gameSessionPda, gameSessionBump] = await PublicKey.findProgramAddressSync(
            [Buffer.from('game_session')],
            PROGRAM_ID
        );
        console.log('Game Session PDA:', gameSessionPda.toBase58());

        // 2. Проверяем, что game_session существует (иначе инициализировать player_bets нельзя)
        console.log("DEBUG: Getting account info for game_session PDA...");
        const gameSessionAccount = await connection.getAccountInfo(gameSessionPda);
        if (gameSessionAccount === null) {
            console.error(`ERROR: GameSession account (${gameSessionPda.toBase58()}) not found. Run init-game.js first.`);
            return; // Выходим, если game_session не инициализирован
        }
        console.log("DEBUG: GameSession account found.");

        // 3. Находим PDA для player_bets
        const playerPubkey = playerSigner.publicKey;
        console.log(`DEBUG: Finding Program Address for player_bets for player ${playerPubkey.toBase58()}...`);
        const [playerBetsPda, playerBetsBump] = await PublicKey.findProgramAddressSync(
            [Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()],
            PROGRAM_ID
        );
        console.log('Player Bets PDA:', playerBetsPda.toBase58());

        // 4. Проверяем существование аккаунта player_bets
        console.log("DEBUG: Getting account info for player_bets PDA...");
        const playerBetsAccount = await connection.getAccountInfo(playerBetsPda);
        console.log("DEBUG: PlayerBets Account info received:", playerBetsAccount !== null);

        if (playerBetsAccount === null) {
            console.log('DEBUG: PlayerBets Account is null, preparing initialization...');
            // --- Вызов initialize_player_bets ---
            const discriminatorInit = findInstructionDiscriminator(idl, 'initialize_player_bets');
            console.log("DEBUG: Discriminator found:", discriminatorInit);

            const keysInit = [
                { pubkey: playerPubkey, isSigner: true, isWritable: true }, // player (payer)
                { pubkey: gameSessionPda, isSigner: false, isWritable: false }, // game_session (read-only for seeds)
                { pubkey: playerBetsPda, isSigner: false, isWritable: true }, // player_bets account to init
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },      // rent sysvar
            ];

            const instructionInit = new TransactionInstruction({
                keys: keysInit,
                programId: PROGRAM_ID,
                data: discriminatorInit,
            });

            const transactionInit = new Transaction().add(instructionInit);
            console.log("DEBUG: Sending initialize_player_bets transaction...");
            transactionSignature = await sendAndConfirmTransaction(
                connection,
                transactionInit,
                [playerSigner] // Подписываем транзакцию ключом игрока (он же плательщик)
            );
            console.log('Initialize PlayerBets transaction successful:', transactionSignature);
            console.log(`   Explorer link: https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`);
            console.log('Player Bets account initialized!');

        } else {
            console.log(`Player Bets account (${playerBetsPda.toBase58()}) already exists for player ${playerPubkey.toBase58()}.`);
        }

    } catch (error) {
        console.error('Ошибка во время инициализации аккаунта ставок игрока:', error);
        if (transactionSignature) {
            console.error(`   Last successful/attempted transaction: https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`);
        }
        if (error.logs) {
            console.error('Логи ошибки:', error.logs);
        } else if (error.message && error.message.includes("custom program error")) {
            // Попытка извлечь код ошибки
            const match = error.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
            const errorCodeHex = match ? match[1] : null;
            const errorCodeDec = errorCodeHex ? parseInt(errorCodeHex, 16) : null;
            console.error(`Получена ошибка программы: ${error.message} (Code: ${errorCodeDec || 'N/A'})`);
            // Найти описание ошибки в IDL
            if (errorCodeDec !== null) {
                const errorEntry = idl.errors.find(e => e.code === errorCodeDec);
                if (errorEntry) {
                    console.error(`   Error Name: ${errorEntry.name}`);
                    console.error(`   Error Msg: ${errorEntry.msg}`);
                } else {
                    console.error("   Описание для этого кода ошибки не найдено в IDL.");
                }
            }
        } else {
             console.error("Full error object:", error); // Вывести весь объект ошибки
        }
    }
}

// Вызываем основную функцию
console.log(">>> Calling initializePlayerBetsAccount function...");
initializePlayerBetsAccount().then(() => {
    console.log(">>> Script execution finished.");
}).catch(err => {
    console.error(">>> Unhandled error in script execution:", err);
});
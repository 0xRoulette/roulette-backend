const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const fs = require('fs');
const borsh = require('@coral-xyz/borsh'); // Используем новый пакет

// --- КОНФИГУРАЦИЯ ---
const RPC_URL = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('32T21T93tobSziz7QSojRwsDiWawnr66ys2db8WbBioF'); // ID программы // <--- УБЕДИСЬ, что это НОВЫЙ Program ID
const IDL_PATH = './roulette_game.json'; // Путь к IDL файлу программы
const AUTHORITY_KEYPAIR_PATH = process.env.HOME + '/.config/solana/id.json'; // Путь к ключу authority

// --- Размеры больше не нужны ---
// const INITIAL_SPACE = 128; // Размер после initialize_game_session (проверяется по IDL)
// --- КОНЕЦ КОНФИГУРАЦИИ ---

const connection = new Connection(RPC_URL, 'confirmed');

let authoritySigner;
try {
    const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_KEYPAIR_PATH)));
    authoritySigner = Keypair.fromSecretKey(keypairData);
    console.log('Authority Keypair loaded:', authoritySigner.publicKey.toBase58());
} catch (err) {
    console.error(`Failed to load authority keypair from ${AUTHORITY_KEYPAIR_PATH}:`, err);
    process.exit(1);
}

let idl;
try {
    idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    console.log('IDL loaded successfully.');
} catch (err) {
    console.error(`Failed to load IDL from ${IDL_PATH}:`, err);
    process.exit(1);
}

function findInstructionDiscriminator(idl, instructionName) {
    const instruction = idl.instructions.find(ix => ix.name === instructionName);
    if (!instruction || !instruction.discriminator) {
        throw new Error(`Discriminator for instruction "${instructionName}" not found in IDL`);
    }
    // Дискриминатор в IDL должен быть массивом чисел
    if (Array.isArray(instruction.discriminator)) {
       return Buffer.from(instruction.discriminator);
    } else {
       // Если формат другой, можно попробовать декодировать base64, но лучше исправить IDL
       console.warn(`Unexpected discriminator format for ${instructionName}, check IDL generation.`);
       try {
           return Buffer.from(instruction.discriminator, 'base64');
       } catch (e) {
            throw new Error(`Failed to decode discriminator for ${instructionName}`);
       }
    }
}

// --- Функция callResizeInstruction больше не нужна ---

async function initializeGameSession() {
    console.log(">>> Entering initializeGameSession function (single step init)...");
    // Находим PDA для game_session
    const [gameSessionPda, gameSessionBump] = await PublicKey.findProgramAddress(
        [Buffer.from('game_session')],
        PROGRAM_ID
    );
    console.log('Game Session PDA:', gameSessionPda.toBase58());

    let transactionSignature; // Для хранения последней подписи

    try {
        // 1. Проверяем существование аккаунта
        const gameSessionAccount = await connection.getAccountInfo(gameSessionPda);

        if (gameSessionAccount === null) {
            console.log('Game Session account does not exist. Initializing...');
            // --- Вызов initialize_game_session ---
            const discriminatorInit = findInstructionDiscriminator(idl, 'initialize_game_session');
            const keysInit = [
                { pubkey: authoritySigner.publicKey, isSigner: true, isWritable: true }, // authority (payer)
                { pubkey: gameSessionPda, isSigner: false, isWritable: true },           // game_session account to init
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },      // rent sysvar
            ];

            // --- REWARD_TOKEN_MINT удален из ключей ---

            const instructionInit = new TransactionInstruction({
                keys: keysInit,
                programId: PROGRAM_ID,
                data: discriminatorInit,
            });
            const transactionInit = new Transaction().add(instructionInit);
            console.log("Sending initialize_game_session transaction...");
            transactionSignature = await sendAndConfirmTransaction(
                connection,
                transactionInit,
                [authoritySigner] // Подписываем транзакцию ключом authority
            );
            console.log('Initialize transaction successful:', transactionSignature);
            console.log(`   Explorer link: https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`);
            console.log('Game Session initialized!');
        } else {
            const currentSize = gameSessionAccount.data.length;
            console.log(`Game Session account already exists. Current size: ${currentSize}`);
            // Опционально: проверить размер и вывести предупреждение, если он не равен ожидаемому из IDL/программы
             const expectedSize = 128; // Размер из Rust кода
             if (currentSize !== expectedSize) {
                 console.warn(`   WARNING: Expected size ${expectedSize} but found ${currentSize}. The account might be from an older version or incorrectly initialized.`);
             }
             console.log('Game Session already initialized.');
        }

        // --- Логика ресайза удалена ---

    } catch (error) {
        console.error('Ошибка во время инициализации игровой сессии:', error);
        if (transactionSignature) {
             console.error(`   Last successful/attempted transaction: https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`);
        }
        if (error.logs) {
            console.error('Логи ошибки:', error.logs);
        } else if (error.message && error.message.includes("custom program error")) {
             console.error("Получена ошибка программы:", error.message);
             // Здесь можно добавить извлечение кода ошибки, если нужно
        }
    }
}

// Вызываем основную функцию
console.log(">>> Calling initializeGameSession function...");
initializeGameSession().then(() => {
    console.log(">>> Script execution finished.");
}).catch(err => {
    console.error(">>> Unhandled error in script execution:", err);
});
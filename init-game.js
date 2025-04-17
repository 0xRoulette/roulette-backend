const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
console.log("DEBUG: @solana/web3.js loaded"); // <--- МЕТКА 1
const fs = require('fs');
console.log("DEBUG: fs loaded"); // <--- МЕТКА 2
const borsh = require('@coral-xyz/borsh'); // Используем новый пакет
console.log("DEBUG: @coral-xyz/borsh loaded"); // <--- МЕТКА 3

// --- Сначала загружаем IDL ---
const IDL_PATH = './roulette_game.json'; // Путь к IDL файлу программы
let idl;
try {
    console.log("DEBUG: Trying to load IDL..."); // <--- МЕТКА 8 (перемещено)
    idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    console.log('IDL loaded successfully.'); // <--- МЕТКА 9 (перемещено)
} catch (err) {
    console.error(`Failed to load IDL from ${IDL_PATH}:`, err);
    process.exit(1);
}

// --- Теперь используем загруженный IDL в конфигурации ---
const RPC_URL = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(idl.address); // Теперь idl определен
const AUTHORITY_KEYPAIR_PATH = process.env.HOME + '/.config/solana/id.json'; // Путь к ключу authority
console.log("DEBUG: Configuration set"); // <--- МЕТКА 4 (остается)

// --- Размеры больше не нужны ---
// const INITIAL_SPACE = 128; // Размер после initialize_game_session (проверяется по IDL)
// --- КОНЕЦ КОНФИГУРАЦИИ ---

const connection = new Connection(RPC_URL, 'confirmed');
console.log("DEBUG: Connection created"); // <--- МЕТКА 5 (остается)

let authoritySigner;
try {
    console.log("DEBUG: Trying to load authority keypair..."); // <--- МЕТКА 6 (остается)
    const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_KEYPAIR_PATH)));
    authoritySigner = Keypair.fromSecretKey(keypairData);
    console.log('Authority Keypair loaded:', authoritySigner.publicKey.toBase58()); // <--- МЕТКА 7 (остается)
} catch (err) {
    console.error(`Failed to load authority keypair from ${AUTHORITY_KEYPAIR_PATH}:`, err);
    process.exit(1);
}

function findInstructionDiscriminator(idl, instructionName) {
    console.log(`DEBUG: Finding discriminator for ${instructionName}...`); // <--- МЕТКА 10 (вызовется позже)
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
    console.log("DEBUG: Entering initializeGameSession..."); // <--- МЕТКА 11
    // Находим PDA для game_session
    console.log("DEBUG: Finding Program Address for game_session..."); // <--- МЕТКА 12
    const [gameSessionPda, gameSessionBump] = await PublicKey.findProgramAddress(
        [Buffer.from('game_session')],
        PROGRAM_ID
    );
    console.log('Game Session PDA:', gameSessionPda.toBase58()); // <--- МЕТКА 13

    let transactionSignature; // Для хранения последней подписи

    try {
        // 1. Проверяем существование аккаунта
        console.log("DEBUG: Getting account info for game_session PDA..."); // <--- МЕТКА 14
        const gameSessionAccount = await connection.getAccountInfo(gameSessionPda);
        console.log("DEBUG: Account info received:", gameSessionAccount !== null); // <--- МЕТКА 15

        if (gameSessionAccount === null) {
            console.log('DEBUG: Account is null, preparing initialization...'); // <--- МЕТКА 16
            // --- Вызов initialize_game_session ---
            const discriminatorInit = findInstructionDiscriminator(idl, 'initialize_game_session');
            console.log("DEBUG: Discriminator found:", discriminatorInit); // <--- МЕТКА 17
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
            console.log("DEBUG: Sending initialize_game_session transaction..."); // <--- МЕТКА 18
            transactionSignature = await sendAndConfirmTransaction(
                connection,
                transactionInit,
                [authoritySigner] // Подписываем транзакцию ключом authority
            );
            console.log('Initialize transaction successful:', transactionSignature); // <--- МЕТКА 19
            console.log(`   Explorer link: https://explorer.solana.com/tx/${transactionSignature}?cluster=devnet`);
            console.log('Game Session initialized!');
        } else {
            console.log("DEBUG: Account already exists."); // <--- МЕТКА 20
            const currentSize = gameSessionAccount.data.length;
            console.log(`Game Session account already exists. Current size: ${currentSize}`);
            // Опционально: проверить размер и вывести предупреждение, если он не равен ожидаемому из IDL/программы
            const expectedSize = 85; // <<< ИЗМЕНЕНО с 128 на 85
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
console.log(">>> Calling initializeGameSession function..."); // <--- МЕТКА 21
initializeGameSession().then(() => {
    console.log(">>> Script execution finished."); // <--- МЕТКА 22
}).catch(err => {
    console.error(">>> Unhandled error in script execution:", err);
});
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

// Конфигурация
const RPC_URL = 'https://api.devnet.solana.com';
const IDL_PATH = './roulette_game.json';
const WALLET_TO_CHECK = 'BzV73m5vrEz19mEbwkTSxxDHSAG8Rpv99xBGtZCfT7YU';

// Загружаем IDL
let idl;
try {
    console.log("Загрузка IDL...");
    idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    console.log('IDL успешно загружен.');
} catch (err) {
    console.error(`Не удалось загрузить IDL из ${IDL_PATH}:`, err);
    process.exit(1);
}

const PROGRAM_ID = new PublicKey(idl.address);
const connection = new Connection(RPC_URL, 'confirmed');

async function checkPlayerBetsAccount() {
    try {
        console.log("Проверка аккаунта PlayerBets для:", WALLET_TO_CHECK);
        const userPubkey = new PublicKey(WALLET_TO_CHECK);
        
        // Находим PDA для game_session
        const [gameSessionPda] = await PublicKey.findProgramAddress(
            [Buffer.from('game_session')],
            PROGRAM_ID
        );
        console.log('Game Session PDA:', gameSessionPda.toBase58());
        
        // Находим PDA для player_bets
        const [playerBetsPda] = await PublicKey.findProgramAddress(
            [Buffer.from('player_bets'), gameSessionPda.toBuffer(), userPubkey.toBuffer()],
            PROGRAM_ID
        );
        console.log('Player Bets PDA для проверяемого кошелька:', playerBetsPda.toBase58());
        
        // Проверяем существование аккаунта
        const accountInfo = await connection.getAccountInfo(playerBetsPda);
        
        console.log("\n=== РЕЗУЛЬТАТ ПРОВЕРКИ ===");
        if (accountInfo) {
            console.log("✓ Аккаунт PlayerBets СУЩЕСТВУЕТ!");
            console.log("Размер данных:", accountInfo.data.length, "байт");
            console.log("Владелец:", accountInfo.owner.toBase58());
            console.log("Баланс:", accountInfo.lamports / 1000000000, "SOL");
            
            // Проверим дискриминатор - должен совпадать с PlayerBets
            const discriminator = accountInfo.data.slice(0, 8);
            console.log("Дискриминатор аккаунта (hex):", Buffer.from(discriminator).toString('hex'));
            
            // Сравним с дискриминатором в IDL
            const playerBetsDiscriminator = idl.accounts.find(acc => acc.name === "PlayerBets")?.discriminator;
            if (playerBetsDiscriminator) {
                const idlDiscriminatorBuf = Buffer.from(playerBetsDiscriminator);
                console.log("Дискриминатор из IDL (hex):", idlDiscriminatorBuf.toString('hex'));
                console.log("Совпадение дискриминаторов:", Buffer.compare(Buffer.from(discriminator), idlDiscriminatorBuf) === 0 ? "Да" : "Нет");
            }
        } else {
            console.log("✗ Аккаунт PlayerBets НЕ СУЩЕСТВУЕТ!");
            console.log("Либо аккаунт не был создан, либо был закрыт.");
        }
        
        // Проверим также код ошибки 101
        console.log("\n=== АНАЛИЗ ОШИБКИ CUSTOM 101 ===");
        console.log("Error Code 101 (0x65) не соответствует AlreadyInitialized (код 6020)");
        
        // Преобразуем 101 в десятичный формат
        const errorCodeDec = 101;
        console.log(`Custom Error Code: ${errorCodeDec} (0x${errorCodeDec.toString(16)})`);
        
        // Ищем ошибку в IDL
        const errorEntry = idl.errors.find(e => e.code === errorCodeDec + 6000);
        if (errorEntry) {
            console.log(`Найденная ошибка (IDL): ${errorEntry.name} - ${errorEntry.msg}`);
        } else {
            console.log("Ошибка с таким кодом не найдена в IDL.");
            console.log("ВАЖНО: Код 101 может быть ошибкой валидации, а не пользовательской ошибкой контракта.");
        }
        
        // Проверяем разницу дискриминаторов в IDL и успешном скрипте
        console.log("\n=== АНАЛИЗ ДИСКРИМИНАТОРОВ ===");
        const idlDiscriminator = idl.instructions.find(inst => inst.name === 'initialize_player_bets')?.discriminator;
        console.log("Дискриминатор из IDL:", idlDiscriminator);
        console.log("Дискриминатор из успешного скрипта: [16, 59, 40, 179, 246, 117, 87, 237]");
        console.log("ВЫВОД: Первый байт отличается (16 vs 22)! Необходимо использовать [16, 59, 40, 179, 246, 117, 87, 237]");
        
        // Проверяем порядок ключей в IDL
        console.log("\n=== ПОРЯДОК АККАУНТОВ В IDL ===");
        const initPlayerBetsInstruction = idl.instructions.find(inst => inst.name === 'initialize_player_bets');
        if (initPlayerBetsInstruction) {
            console.log("Порядок аккаунтов в IDL:");
            initPlayerBetsInstruction.accounts.forEach((acc, idx) => {
                console.log(`${idx + 1}. ${acc.name}`);
            });
            console.log("\nВАЖНО: Порядок ключей должен точно соответствовать этому порядку!");
        }
    } catch (error) {
        console.error('Ошибка при проверке аккаунта:', error);
    }
}

// Запускаем проверку
checkPlayerBetsAccount().then(() => {
    console.log("\nПроверка завершена.");
});
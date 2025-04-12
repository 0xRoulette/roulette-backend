const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
    player: { type: String, required: true },
    round: { type: Number, required: true },
    tokenMint: { type: String, required: true, index: true },
    betAmount: { type: String, required: true }, // <<< Изменил тип на String, т.к. сохраняем из bet.amount.toString()
    betType: { type: Number, required: true },
    betNumbers: [{ type: Number }],
    timestamp: { type: Date, required: true },
    signature: { type: String, required: true }, // Уникальный ключ транзакции
    // <<< НАЧАЛО ИЗМЕНЕНИЙ: Добавляем поле gameSessionPubkey >>>
    gameSessionPubkey: { type: String, required: true } // Ключ игровой сессии
    // <<< КОНЕЦ ИЗМЕНЕНИЙ: Добавляем поле gameSessionPubkey >>>
});

// <<< НАЧАЛО ИЗМЕНЕНИЙ: Обновляем составной индекс >>>
// Индекс для быстрого поиска ставок в конкретном раунде конкретной сессии
betSchema.index({ gameSessionPubkey: 1, round: 1, timestamp: -1 }); // Добавили gameSessionPubkey и сортировку по времени
// <<< КОНЕЦ ИЗМЕНЕНИЙ: Обновляем составной индекс >>>

// Убираем старый индекс, если он больше не нужен
// betSchema.index({ round: 1, tokenMint: 1 }); // Можно закомментировать или удалить

const Bet = mongoose.model('Bet', betSchema);

module.exports = Bet;
const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
    player: { type: String, required: true }, // Убираем отдельный индекс
    round: { type: Number, required: true }, // Убираем отдельный индекс
    tokenMint: { type: String, required: true, index: true },
    betAmount: { type: Number, required: true }, // Сумма конкретной этой ставки
    betType: { type: Number, required: true },   // Тип ставки (числовой)
    betNumbers: [{ type: Number }],              // Числа, на которые поставлено (массив)
    timestamp: { type: Date, required: true },   // Время ставки (из события блокчейна)
    signature: { type: String, required: true, unique: true } // Сигнатура транзакции, чтобы избежать дубликатов
});

// Добавляем составной индекс для оптимизации запросов, если понадобится
betSchema.index({ round: 1, tokenMint: 1 }); // Составной индекс для запросов по раунду и токену

const Bet = mongoose.model('Bet', betSchema);

module.exports = Bet; 
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
});

betSchema.index({ round: 1, timestamp: -1 }); // Индекс для поиска по раунду и сортировки по времени

const Bet = mongoose.model('Bet', betSchema);

module.exports = Bet;
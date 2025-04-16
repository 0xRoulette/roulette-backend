const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ClaimRecordSchema = new Schema({
  player: { type: String, required: true, index: true },
  round: { type: Number, required: true, index: true },
  claimSignature: { type: String, required: true, unique: true }, // Подпись транзакции клейма
  claimedTimestamp: { type: Date, default: Date.now },
}, { timestamps: true });

// Составной индекс для быстрого поиска по игроку и раунду
ClaimRecordSchema.index({ player: 1, round: 1 }, { unique: true }); // Гарантирует уникальность пары игрок-раунд

module.exports = mongoose.model('ClaimRecord', ClaimRecordSchema); 
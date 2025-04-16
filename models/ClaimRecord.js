const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ClaimRecordSchema = new Schema({
  player: { type: String, required: true, index: true }, // Ключ игрока
  round: { type: Number, required: true, index: true },  // Номер раунда
  claimSignature: { type: String, required: true, unique: true }, // Подпись клейма (уникальна)
  claimedTimestamp: { type: Date, default: Date.now }, // Время клейма
}, { timestamps: true }); // Автоматические createdAt/updatedAt

// Индекс для быстрого поиска и гарантии уникальности клейма на раунд для игрока
ClaimRecordSchema.index({ player: 1, round: 1 }, { unique: true });

module.exports = mongoose.model('ClaimRecord', ClaimRecordSchema); 
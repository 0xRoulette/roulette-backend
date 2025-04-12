const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// PayoutDetailSchema остается без изменений
const PayoutDetailSchema = new Schema({
  address: { type: String, required: true, index: true },
  amount: { type: String, required: true }
}, { _id: false });

const RoundPayoutSchema = new Schema({
  round: { type: Number, required: true }, // Убираем unique: true здесь, если используем составной индекс
  winningNumber: { type: Number, required: true },
  // payoutRootHex: { type: String, required: true }, // <<< УДАЛЯЕМ ЭТО ПОЛЕ
  payouts: [PayoutDetailSchema], // Массив победителей и сумм
  onChainSubmitTx: { type: String, default: null }, // Можно оставить для справки, если нужно
  onChainSubmitError: { type: String, default: null }, // Можно оставить для справки, если нужно
}, {
  timestamps: true
});


const RoundPayoutModel = mongoose.model('RoundPayout', RoundPayoutSchema);
module.exports = RoundPayoutModel;

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Определяем схему для отдельной выплаты внутри раунда
const PayoutDetailSchema = new Schema({
  address: {
    type: String,
    required: true,
    index: true // Индекс по адресу игрока может быть полезен
  },
  amount: {
    type: String, // Сохраняем как строку, т.к. это может быть BigNumber
    required: true
  }
}, { _id: false }); // Не создаем отдельные _id для под-документов

// Основная схема для данных раунда
const RoundPayoutSchema = new Schema({
  round: {
    type: Number,
    required: true,
    unique: true, // Каждый раунд уникален
    index: true   // Индексируем для быстрого поиска по номеру раунда
  },
  winningNumber: {
    type: Number,
    required: true
  },
  payoutRootHex: {
    type: String,
    required: true // Корень дерева Меркла для этого раунда
  },
  payouts: [PayoutDetailSchema], // Массив выплат для этого раунда
  onChainSubmitTx: {
    type: String, // Подпись транзакции отправки корня в блокчейн
    default: null
  },
  onChainSubmitError: {
    type: String, // Сообщение об ошибке при отправке корня, если была
    default: null
  }
}, {
  timestamps: true // Добавляет поля createdAt и updatedAt автоматически
});

// Создаем и экспортируем модель
const RoundPayoutModel = mongoose.model('RoundPayout', RoundPayoutSchema);

module.exports = RoundPayoutModel;
// controllers/transactionController.js
const transactionService = require('../services/transactionService');
const requestContext = require('../utils/requestContext');

exports.getUserTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.body;

    const { transactions, totalCount } = await transactionService.getTransactionsByOperator(
      requestContext.getOperatorId(),
      req.body.userId,
      parseInt(page),
      parseInt(limit),
      requestContext.isSuperUser()
    );

    res.json({
      data: transactions,
      page: parseInt(page),
      limit: parseInt(limit),
      totalCount
    });
  } catch (err) {
    console.error('Failed to fetch transactions:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};

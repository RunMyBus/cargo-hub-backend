const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../testHelpers');

const CashTransferService = require('../../services/CashTransferService');
const CashTransfer = require('../../models/CashTransfer');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const Operator = require('../../models/Operator');

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

describe('CashTransferService.updateCashTransfer', () => {
  it('should create sender and receiver transactions with correct balances on approval', async () => {
    const operator = await Operator.create({
      name: 'Test Operator',
      code: 'OP1',
      phone: '9999999999'
    });

    const fromUser = await User.create({
      fullName: 'Sender User',
      mobile: '8888888888',
      operatorId: operator._id,
      cargoBalance: 1000
    });

    const toUser = await User.create({
      fullName: 'Receiver User',
      mobile: '9999999990',
      operatorId: operator._id,
      cargoBalance: 200
    });

    const transfer = await CashTransfer.create({
      amount: 300,
      description: 'Test transfer',
      fromUser: fromUser._id,
      toUser: toUser._id,
      status: 'Pending',
      operatorId: operator._id
    });

    await CashTransferService.updateCashTransfer(transfer._id, { status: 'Approved' });

    const updatedFrom = await User.findById(fromUser._id);
    const updatedTo = await User.findById(toUser._id);

    expect(updatedFrom.cargoBalance).toBe(700);
    expect(updatedTo.cargoBalance).toBe(500);

    const transactions = await Transaction.find({ cashTransferId: transfer._id }).sort({ createdAt: 1 });
    expect(transactions).toHaveLength(2);

    const senderTxn = transactions.find(t => t.user.toString() === fromUser._id.toString());
    const receiverTxn = transactions.find(t => t.user.toString() === toUser._id.toString());

    expect(senderTxn).toBeDefined();
    expect(receiverTxn).toBeDefined();

    expect(senderTxn.oldBalance).toBe(1000);
    expect(senderTxn.balanceAfter).toBe(700);
    expect(senderTxn.amount).toBe(300);
    expect(senderTxn.fromUser.toString()).toBe(fromUser._id.toString());
    expect(senderTxn.toUser.toString()).toBe(toUser._id.toString());
    expect(senderTxn.description).toBe('Cash transfer of ₹300 sent to Receiver User');

    expect(receiverTxn.oldBalance).toBe(200);
    expect(receiverTxn.balanceAfter).toBe(500);
    expect(receiverTxn.amount).toBe(300);
    expect(receiverTxn.fromUser.toString()).toBe(fromUser._id.toString());
    expect(receiverTxn.toUser.toString()).toBe(toUser._id.toString());
    expect(receiverTxn.description).toBe('Cash transfer of ₹300 received from Sender User');
  });
});

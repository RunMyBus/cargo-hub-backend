// services/CashTransferService.js
const CashTransfer = require('../models/CashTransfer');
const User = require('../models/User');
const logger = require('../utils/logger');
const Transaction = require('../models/Transaction');
const { Parser } = require('json2csv');
const { appendOperatorFilter } = require('../utils/operatorFilter');

class CashTransferService {
    static async createCashTransfer(data, operatorId, user) {
        const { amount, description, fromUser, toUser } = data;

            if (!amount || !fromUser || !toUser) {
            throw new Error('Missing required fields: amount, fromUser, or toUser');
        }

        const newTransfer = new CashTransfer({
            amount,
            description,
            fromUser,
            toUser,
            operatorId,
            status: 'Pending'
            });

        return await newTransfer.save();
    }

static async getCashTransfers(operatorId, status, { page, limit }, user) {
    const query = appendOperatorFilter({
        $or: [
            { fromUser: user._id },
            { toUser: user._id }
        ]
    }, operatorId);

    // Handle custom status filtering
    if (status) {
        if (status === 'NonPending') {
            query.status = { $in: ['Approved', 'Rejected'] };
        } else {
            query.status = status;
        }
    }

    const skip = (page - 1) * limit;

    const [transfers, totalRecords] = await Promise.all([
        CashTransfer.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('fromUser', 'fullName')
            .populate('toUser', 'fullName'),
        CashTransfer.countDocuments(query)
    ]);

    const formattedTransfers = transfers.map((t, index) => ({
        sNo: skip + index + 1,
        _id: t._id,
        amount: t.amount,
        description: t.description,
        status: t.status,
        date: t.createdAt.toISOString().split('T')[0],
        fromUser: t.fromUser ? { _id: t.fromUser._id, fullName: t.fromUser.fullName } : null,
        toUser: t.toUser ? { _id: t.toUser._id, fullName: t.toUser.fullName } : null,
        createdBy: t.fromUser ? { _id: t.fromUser._id, fullName: t.fromUser.fullName } : null
    }));

    return {
        page,
        limit,
        totalPages: Math.ceil(totalRecords / limit),
        totalRecords,
        data: formattedTransfers
    };
}



    static async getCashTransfersByStatus(operatorId, status, { page, limit }) {
        const query = appendOperatorFilter({}, operatorId);

        if (status === 'Pending') {
        query.status = 'Pending';
        } else if (status === 'NonPending') {
        query.status = { $in: ['Approved', 'Rejected'] };
        } else if (['Approved', 'Rejected'].includes(status)) {
        query.status = status;
        }

        const skip = (page - 1) * limit;

        const [total, data] = await Promise.all([
        CashTransfer.countDocuments(query),
        CashTransfer.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
        ]);

        return {
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        totalRecords: total,
        data
        };
    }

    static async updateCashTransferStatus(id, newStatus) {
        const allowedStatuses = ['Pending', 'Approved', 'Rejected'];
        if (!allowedStatuses.includes(newStatus)) {
        throw new Error('Invalid status value');
        }

        const transfer = await CashTransfer.findById(id);
        if (!transfer) {
        throw new Error('Cash transfer not found');
        }

        if (transfer.status !== 'Pending') {
        throw new Error('Cash transfer already processed');
        }

        if (newStatus === 'Approved') {
        const [fromUser, toUser] = await Promise.all([
            User.findById(transfer.fromUser),
            User.findById(transfer.toUser),
        ]);

        if (!fromUser || !toUser) {
            throw new Error('FromUser or ToUser not found');
        }

        if ((fromUser.cargoBalance || 0) < transfer.amount) {
            throw new Error('Insufficient cargo balance for transfer');
        }

        fromUser.cargoBalance -= transfer.amount;
        toUser.cargoBalance = (toUser.cargoBalance || 0) + transfer.amount;

        await Promise.all([fromUser.save(), toUser.save()]);
        }

        transfer.status = newStatus;
        await transfer.save();

        return transfer;
    }

 static async updateCashTransfer(id, updateData) {
    const allowedFields = ['amount', 'description', 'fromUser', 'toUser', 'status'];
    const updatePayload = {};

    const allowedStatuses = ['Pending', 'Approved', 'Rejected'];
    if (updateData.status !== undefined) {
        if (!allowedStatuses.includes(updateData.status)) {
            throw new Error('Invalid status value');
        }
    }

    const transfer = await CashTransfer.findById(id);
    if (!transfer) {
        throw new Error('Cash transfer not found');
    }

    if (
        updateData.status !== undefined &&
        transfer.status !== 'Pending'
    ) {
        throw new Error('Cash transfer already processed');
    }

    if (updateData.status === 'Approved') {
        const [fromUser, toUser] = await Promise.all([
            User.findById(transfer.fromUser),
            User.findById(transfer.toUser)
        ]);

        if (!fromUser || !toUser) {
            throw new Error('FromUser or ToUser not found');
        }

        if ((fromUser.cargoBalance || 0) < transfer.amount) {
            throw new Error('Insufficient cargo balance for transfer');
        }

        // Update balances
        const fromOldBalance = fromUser.cargoBalance || 0;
        const toOldBalance = toUser.cargoBalance || 0;
        fromUser.cargoBalance -= transfer.amount;
        toUser.cargoBalance = (toUser.cargoBalance || 0) + transfer.amount;

        await Promise.all([fromUser.save(), toUser.save()]);

        //  Create a Transaction document
        await Transaction.create({
            user: fromUser._id, 
            fromUser: fromUser._id,
            toUser: toUser._id,
            amount: transfer.amount,
            oldBalance: fromOldBalance,
            balanceAfter: fromUser.cargoBalance,
            type: 'Transfer',
            description: `Cash transfer of ₹${transfer.amount} sent to ${toUser.fullName}`,
            referenceId: null,
            cashTransferId: transfer._id, 
        });
        //  Create a Transaction document
        await Transaction.create({
            user: toUser._id, 
            fromUser: fromUser._id,
            toUser: toUser._id,
            oldBalance: toOldBalance,
            amount: transfer.amount,
            balanceAfter: toUser.cargoBalance,
            type: 'Transfer',
            description: `Cash transfer of ₹${transfer.amount} received from ${fromUser.fullName}`,
            referenceId: null,
            cashTransferId: transfer._id, 
        });
    }

    for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
            updatePayload[field] = updateData[field];
        }
    }

    const updated = await CashTransfer.findByIdAndUpdate(id, updatePayload, {
        new: true,
        runValidators: true
    });

    return updated;
}


    static async deleteCashTransfer(id) {
        return await CashTransfer.findByIdAndDelete(id);
    }

    static async exportPendingTransfersCSV(operatorId) {
        try {
        const transfers = await CashTransfer.find(
            appendOperatorFilter({ status: 'Pending' }, operatorId)
        )
            .sort({ createdAt: -1 })
            .populate('fromUser', 'fullName')
            .populate('toUser', 'fullName');

            if (!transfers.length) {
                throw new Error('No pending transfers found');
            }

            const csvData = transfers.map((t, idx) => ({
                SNo: idx + 1,
                Date: t.createdAt.toISOString().split('T')[0],
                From: t.fromUser ? t.fromUser.fullName : '',                
                To: t.toUser ? t.toUser.fullName : '',
                Amount: t.amount,
                Description: t.description,
                Status: t.status,                
            }));

            const fields = ['SNo', 'Date', 'From', 'To', 'Amount', 'Description','Status'];
            const json2csvParser = new Parser({ fields });
            return json2csvParser.parse(csvData);

        } catch (error) {
            console.error('Service exportPendingTransfersCSV error:', error);
            throw error;
        }
    }
}

module.exports = CashTransferService;

const Transaction = require('../models/Transaction');
const Booking = require('../models/Booking');
const CashTransfer = require('../models/CashTransfer');
const mongoose = require('mongoose');

exports.getTransactionsByOperator = async (operatorId, userId, page, limit, isSuperUser = false) => {
  const skip = (page - 1) * limit;

  // Validate inputs
  const hasUserId = userId && userId.toString().trim() !== '' && mongoose.Types.ObjectId.isValid(userId);
  const hasOperatorId = !isSuperUser && operatorId && mongoose.Types.ObjectId.isValid(operatorId);

  // ── 1. Get Booking IDs (scoped to operator unless SuperUser) ─────────────
  const bookingFilter = hasOperatorId ? { operatorId } : {};
  const operatorBookings = await Booking.find(bookingFilter).select('_id').lean();
  const operatorBookingIds = operatorBookings.map(b => b._id);

  // ── 2. Get CashTransfer IDs (approved, scoped to operator unless SuperUser)
  const cashTransferFilter = hasOperatorId
    ? { operatorId, status: 'Approved' }
    : { status: 'Approved' };
  const approvedTransfers = await CashTransfer.find(cashTransferFilter).select('_id').lean();
  const approvedTransferIds = approvedTransfers.map(ct => ct._id);

  // ── 3. Build the base query ───────────────────────────────────────────────
  const baseQuery = {
    $or: [
      { type: { $in: ['Booking', 'Delivered'] }, referenceId: { $in: operatorBookingIds } },
      { type: 'Transfer', cashTransferId: { $in: approvedTransferIds } }
    ]
  };

  // Optionally narrow down to a specific user
  if (hasUserId) {
    baseQuery.user = new mongoose.Types.ObjectId(userId);
  }

  // ── 4. Fetch transactions with populate ───────────────────────────────────
  const transactions = await Transaction.find(baseQuery)
    .populate({
      path: 'referenceId',
      select: 'bookingId bookedBy',
      populate: { path: 'bookedBy', select: 'fullName' }
    })
    .populate('fromUser', 'fullName')
    .populate('toUser', 'fullName')
    .sort({ createdAt: -1 })
    .lean();

  // ── 5. Shape each transaction ─────────────────────────────────────────────
  const shaped = transactions.map(tx => {
    const booking = tx.referenceId;
    const oldBalance = tx.balanceAfter - tx.amount;

    let description = '';
    if (tx.type === 'Booking') {
      const bookedByName = booking?.bookedBy?.fullName || 'Unknown';
      description = `Cargo Booking : ${booking?.bookingId} by ${bookedByName} has been posted for amount of ₹${tx.amount}`;
    } else if (tx.type === 'Delivered') {
      description = `Delivery : Booking ${booking?.bookingId} marked delivered and paid ₹${tx.amount}`;
    } else {
      const fromName = tx.fromUser?.fullName || 'Unknown';
      const toName = tx.toUser?.fullName || 'Unknown';
      description = `Cash Transfer of ₹${tx.amount} from ${fromName} to ${toName}`;
    }

    return {
      _id: tx._id,
      amount: tx.amount,
      balanceAfter: tx.balanceAfter,
      type: tx.type,
      createdAt: tx.createdAt,
      oldBalance,
      bookingId: booking?.bookingId || null,
      bookedByName: booking?.bookedBy?.fullName || null,
      fromUserName: tx.fromUser?.fullName || null,
      toUserName: tx.toUser?.fullName || null,
      description
    };
  });

  // ── 6. Paginate in JavaScript ─────────────────────────────────────────────
  const totalCount = shaped.length;
  const paginated = shaped.slice(skip, skip + limit);

  return {
    transactions: paginated,
    totalCount
  };
};

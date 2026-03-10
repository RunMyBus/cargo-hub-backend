const Transaction = require('../models/Transaction');
const mongoose = require('mongoose');

exports.getTransactionsByOperator = async (operatorId, userId, page, limit) => {
  const skip = (page - 1) * limit;
  
  // Validate userId if provided - only use if it's a valid non-empty value
  const hasUserId = userId && userId.toString().trim() !== '' && mongoose.Types.ObjectId.isValid(userId);
  const operatorObjectId = operatorId && mongoose.Types.ObjectId.isValid(operatorId)
    ? new mongoose.Types.ObjectId(operatorId)
    : null;

  const aggregationPipeline = [
    {
      $match: {
        type: { $in: ['Booking', 'Transfer', 'Delivered'] } // ✅ include Delivered
      }
    },

    // Lookup booking if it's a Booking or Delivered type
    {
      $lookup: {
        from: 'bookings',
        localField: 'referenceId',
        foreignField: '_id',
        as: 'booking'
      }
    },
    { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },

    // Lookup cash transfer if it's a Transfer type
    {
      $lookup: {
        from: 'cashtransfers',
        localField: 'cashTransferId',
        foreignField: '_id',
        as: 'cashTransfer'
      }
    },
    { $unwind: { path: '$cashTransfer', preserveNullAndEmptyArrays: true } },

    // Filter based on operator or approval status
    {
      $match: {
        $or: [
          operatorObjectId
            ? {
                type: { $in: ['Booking', 'Delivered'] },
                'booking.operatorId': operatorObjectId
              }
            : { type: { $in: ['Booking', 'Delivered'] } },
          {
            type: 'Transfer',
            'cashTransfer.status': 'Approved'
          }
        ]
      }
    },

    // Filter by userId if provided
    ...(hasUserId ? [{
      $match: {
        $or: [
          { user: new mongoose.Types.ObjectId(userId) }
        ]
      }
    }] : []),

    // Lookup users
    {
      $lookup: {
        from: 'users',
        localField: 'booking.bookedBy',
        foreignField: '_id',
        as: 'bookedUser'
      }
    },
    { $unwind: { path: '$bookedUser', preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: 'users',
        localField: 'fromUser',
        foreignField: '_id',
        as: 'fromUserObj'
      }
    },
    { $unwind: { path: '$fromUserObj', preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: 'users',
        localField: 'toUser',
        foreignField: '_id',
        as: 'toUserObj'
      }
    },
    { $unwind: { path: '$toUserObj', preserveNullAndEmptyArrays: true } },

    // Add oldBalance field
    {
      $addFields: {
        oldBalance: {
          $ifNull: [
            '$oldBalance',
            { $subtract: ['$balanceAfter', '$amount'] }
          ]
        }
      }
    },

    // Final projection
    {
      $project: {
        _id: 1,
        amount: 1,
        balanceAfter: 1,
        oldBalance: 1,
        createdAt: 1,
        type: 1,
        bookingId: '$booking.bookingId',
        bookedByName: '$bookedUser.fullName',
        fromUserName: '$fromUserObj.fullName',
        toUserName: '$toUserObj.fullName',
        description: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$type', 'Booking'] },
                then: {
                  $concat: [
                    'Cargo Booking : ',
                    { $toString: '$booking.bookingId' },
                    ' by ',
                    { $ifNull: ['$bookedUser.fullName', 'Unknown'] },
                    ' has been posted for amount of ₹',
                    { $toString: '$amount' }
                  ]
                }
              },
              {
                case: { $eq: ['$type', 'Delivered'] },
                then: {
                  $concat: [
                    'Delivery : Booking ',
                    { $toString: '$booking.bookingId' },
                    ' marked delivered and paid ₹',
                    { $toString: '$amount' }
                  ]
                }
              }
            ],
            default: {
              $cond: {
                if: { $eq: ['$user', '$fromUser'] },
                then: {
                  $concat: [
                    'Cash transfer of ₹',
                    { $toString: '$amount' },
                    ' sent to ',
                    { $ifNull: ['$toUserObj.fullName', 'Unknown'] }
                  ]
                },
                else: {
                  $cond: {
                    if: { $eq: ['$user', '$toUser'] },
                    then: {
                      $concat: [
                        'Cash transfer of ₹',
                        { $toString: '$amount' },
                        ' received from ',
                        { $ifNull: ['$fromUserObj.fullName', 'Unknown'] }
                      ]
                    },
                    else: {
                      $concat: [
                        'Cash transfer of ₹',
                        { $toString: '$amount' },
                        ' from ',
                        { $ifNull: ['$fromUserObj.fullName', 'Unknown'] },
                        ' to ',
                        { $ifNull: ['$toUserObj.fullName', 'Unknown'] }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    // Sort by creation date in descending order (newest first)
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit }
  ];

  const results = await Transaction.aggregate(aggregationPipeline);

  // Count aggregation (also includes Delivered now)
  const countAggregationPipeline = [
    {
      $match: {
        type: { $in: ['Booking', 'Transfer', 'Delivered'] }
      }
    },
    {
      $lookup: {
        from: 'bookings',
        localField: 'referenceId',
        foreignField: '_id',
        as: 'booking'
      }
    },
    { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'cashtransfers',
        localField: 'cashTransferId',
        foreignField: '_id',
        as: 'cashTransfer'
      }
    },
    { $unwind: { path: '$cashTransfer', preserveNullAndEmptyArrays: true } },
    {
      $match: {
        $or: [
          {
            type: { $in: ['Booking', 'Delivered'] },
            'booking.operatorId': new mongoose.Types.ObjectId(operatorId)
          },
          {
            type: 'Transfer',
            'cashTransfer.status': 'Approved'
          }
        ]
      }
    },
    // Filter by userId if provided
    ...(hasUserId ? [{
      $match: {
        $or: [
          { user: new mongoose.Types.ObjectId(userId) }
        ]
      }
    }] : []),
    { $count: 'total' }
  ];

  const countAggregation = await Transaction.aggregate(countAggregationPipeline);

  const totalCount = countAggregation[0]?.total || 0;

  return {
    transactions: results,
    totalCount
  };
};

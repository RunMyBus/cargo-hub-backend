const Booking = require('../models/Booking');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Branch = require('../models/Branch');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const { request } = require('express');
const Operator = require('../models/Operator');
const Transaction = require('../models/Transaction');
const UserService = require('./UserService');
const whatsappService = require('../services/whatsappService');
const generatePdfBuffer = require('../utils/bookingTemplate');
const WhatsAppConversation = require('../models/WhatsAppConversation');
const { buildOperatorFilter, appendOperatorFilter } = require('../utils/operatorFilter');

const config = process.env;

class BookingService {
  static booking_confirmed = config.BOOKING_CONFIRMED;
  static booking_arrived = config.BOOKING_ARRIVED;

  static async initiateBooking(data, userId, operatorId) {
    try {
      logger.info('Booking creation request received', {
        userId,
        bookingData: data
      });

      // // Validate input ObjectIds
      // if (!mongoose.Types.ObjectId.isValid(data.fromOffice)) {
      //   throw new Error('Invalid fromOffice ID');
      // }

      // if (!mongoose.Types.ObjectId.isValid(data.toOffice)) {
      //   throw new Error('Invalid toOffice ID');
      // }

      // Validate origin and destination branches
      const [fromBranch, toBranch] = await Promise.all([
        Branch.findOne({ _id: data.fromOffice, operatorId, status: 'Active' }),
        Branch.findOne({ _id: data.toOffice, operatorId, status: 'Active' }),
      ]);

      if (!fromBranch) throw new Error('Invalid or inactive origin branch');
      if (!toBranch) throw new Error('Invalid or inactive destination branch');
      if (data.fromOffice === data.toOffice) {
        throw new Error('Origin and destination branches cannot be the same');
      }

      const now = new Date();
      const pad = (n) => n.toString().padStart(2, '0');
      const year = now.getFullYear();
      const month = pad(now.getMonth() + 1);
      const day = pad(now.getDate());

      // Create booking with initial eventHistory entry
      const booking = new Booking({
        ...data,
        operatorId,
        bookingDate: `${year}-${month}-${day}`,
      });

      // Generate bookingId
      const operator = await Operator.findByIdAndUpdate(
        operatorId,
        { $inc: { bookingSequence: 1 } },
        { new: true, useFindAndModify: false }
      );

      if (!operator) throw new Error('Operator not found');

      const sequenceStr = operator.bookingSequence.toString().padStart(4, '0');
      const typeCode = booking.lrType === 'Paid' ? 'P' : 'TP';
      const datePart = `${day}${month}${year.toString().slice(-2)}`;
      const operatorCode = operator.code;
      booking.bookingId = `${typeCode}-${operatorCode}${datePart}-${sequenceStr}`;

      await booking.save();

      // Populate before returning
      const populatedBooking = await Booking.findById(booking._id)
        .populate('fromOffice', '_id name')
        .populate('toOffice', '_id name')
        .populate('assignedVehicle', '_id vehicleNumber')

      const result = populatedBooking.toObject();

      // Optional: simplify assignedVehicle object
      if (result.assignedVehicle) {
        result.assignedVehicle = {
          _id: result.assignedVehicle._id,
          vehicleNumber: result.assignedVehicle.vehicleNumber,
        };
      }

      logger.info('Booking created successfully', {
        bookingId: result.bookingId
      });

      return result;

    } catch (error) {
      logger.error('Error creating booking', {
        error: error.message,
        stack: error.stack,
        bookingData: data
      });
      throw error;
    }
  }

  static async getAllBookings(operatorId) {
    logger.info('Fetching all bookings', { operatorId });

    try {
      const baseFilter = buildOperatorFilter(operatorId);
      const [bookings, totalCount] = await Promise.all([
        Booking.find(baseFilter)
          .populate('fromOffice', 'name')
          .populate('toOffice', 'name')
          .populate('assignedVehicle', 'vehicleNumber')
          .populate('bookedBy', '_id fullName'),
        Booking.countDocuments(baseFilter)
      ]);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayCount = await Booking.countDocuments(
        appendOperatorFilter({ createdAt: { $gte: todayStart } }, operatorId)
      );

      logger.info('Successfully fetched all bookings', {
        totalCount,
        todayCount,
        operatorId
      });

      return { bookings, totalCount, todayCount };
    } catch (error) {
      logger.error('Error getting all bookings', {
        error: error.message,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async getBookingById(id, operatorId, returnRaw = false) {
    logger.info('Fetching booking by ID', { bookingId: id, operatorId });

    try {
      const booking = await Booking.findOne(appendOperatorFilter({ _id: id }, operatorId))
        .populate('fromOffice', '_id name address phone')
        .populate('toOffice', '_id name address phone')
        .populate('assignedVehicle', '_id vehicleNumber')
        .populate('bookedBy', '_id fullName')

      if (!booking) {
        logger.warn('Booking not found', { bookingId: id, operatorId });
        throw new Error('Booking not found');
      }

      if (returnRaw) {
        return booking;
      }

      const result = booking.toObject();
      result.senderName = result.senderName || result.fromOffice.name;
      return result;
    } catch (error) {
      logger.error('Error getting booking by ID', {
        error: error.message,
        bookingId: id,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async getBookingByBookingId(bookingId, operatorId, returnRaw = false) {
    logger.info('Fetching booking by ID', { bookingId });

    try {
      const booking = await Booking.findOne(appendOperatorFilter({ bookingId }, operatorId))
        .populate('fromOffice', '_id name')
        .populate('toOffice', '_id name')
        .populate('assignedVehicle', '_id vehicleNumber')
        .populate('bookedBy', '_id fullName')

      if (!booking) {
        logger.warn('Booking not found', { bookingId, operatorId });
        throw new Error('Booking not found');
      }

      if (returnRaw) {
        return booking;
      }

      const result = booking.toObject();
      result.senderName = result.senderName || result.fromOffice.name;
      return result;
    } catch (error) {
      logger.error('Error getting booking by bookingId', {
        error: error.message,
        bookingId,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Confirm a booking by updating cargo balance and creating a transaction
   * @param {Object} booking - The booking document
   * @param {string} userId - ID of the user confirming the booking
   * @returns {Promise<void>}
   */
  static async collectPayment(booking, userId, updateData = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      // If lrType changes, update bookingId prefix accordingly, without changing sequence/date/operatorCode
      if (updateData.lrType && updateData.lrType !== booking.lrType) {
        const newTypeCode = updateData.lrType === 'Paid' ? 'P' : 'TP';

        // booking.bookingId format: "P-OPCODEddmmyy-xxxx" or "TP-OPCODEddmmyy-xxxx"
        // Replace prefix with newTypeCode, keep rest same
        booking.bookingId = booking.bookingId.replace(/^(P|TP)/, newTypeCode);

        booking.lrType = updateData.lrType;
      } else if (updateData.lrType) {
        booking.lrType = updateData.lrType;
      }

     // ✅ Update payment type (string only)
    if (updateData.paymentType) {
      booking.paymentType = updateData.paymentType;
    }

    // Update status
    if (updateData.status) booking.status = updateData.status;

    // Set bookedBy if missing
    if (!booking.bookedBy) {
      booking.bookedBy = userId;
    }

      if (
      booking.status === 'Delivered' && !booking.eventHistory.some(e => e.type === 'delivered')) {
        booking.eventHistory.push({
          type: 'delivered',
          user: userId,
          date: new Date(),
          vehicle: booking.assignedVehicle || null,
          branch: null, // optional: add branch if you want
        });
      }
      // Save and populate branch data
      const savedBooking = await booking.save();
      const populatedBooking = await this.getBookingById(savedBooking._id, savedBooking.operatorId);

      // Only update cargo balance for 'Paid' bookings
      if (booking.lrType === 'Paid') {
        const amount = booking.totalAmountCharge || 0;
        const { user: updatedUser, oldBalance, newBalance } = await UserService.addToCargoBalance(userId, amount);

        // Create a transaction record
        await Transaction.create({
          user: userId,
          amount,
          oldBalance,
          balanceAfter: newBalance,
          type: 'Booking',
          referenceId: booking._id, //include the booking id and the amount
          description: `Cargo balance updated from Paid booking: ${booking.bookingId} for amount: ${amount}`
        });

        logger.info('Cargo balance updated for Paid booking', {
          bookingId: booking._id,
          userId,
          amount,
          newBalance
        });
      } else {
        logger.info('ToPay booking — cargo balance not updated', {
          bookingId: booking._id,
          userId,
          lrType: booking.lrType
        });
      }

      logger.info('Booking confirmed and updated successfully', {
        bookingId: booking._id,
        userId,
        lrType: booking.lrType,
        status: booking.status,
        populatedBooking
      });

      if (config.WHATSAPP_ENABLED === 'true') {
        const operator = await Operator.findById(booking.operatorId);
        const operatorConfig = operator?.whatsappConfig || {};

        logger.info('Generating LR', { bookingId: savedBooking._id });

        const pdfBuffer = await generatePdfBuffer(populatedBooking);

        const uploadResponse = await whatsappService.uploadPDF(booking.bookingId, pdfBuffer, operatorConfig);
        if (uploadResponse.success) {
          const mediaId = uploadResponse.mediaId;
          const attributes = [ booking.receiverName, booking.senderName, populatedBooking.fromOffice.name, booking.bookingId, populatedBooking.toOffice.name, populatedBooking.toOffice.phone ];
          logger.info('WhatsApp message attributes', {
            attributes
          });

          /* Dear {{1}}  a parcel is booked for you by {{2}} from {{3}}  with LR NO: {{4}}. Please use this LR NO for reference.
          This will be transported to our office {{5}} soon. For collecting the package please contact our office at {{6}}.*/

          const whatsappMessage = `Dear ${booking.receiverName} a parcel is booked for you by ${booking.senderName} from ${populatedBooking.fromOffice.name} with LR NO: ${booking.bookingId}. Please use this LR NO for reference. This will be transported to our office ${populatedBooking.toOffice.name} soon. For collecting the package please contact our office at ${populatedBooking.toOffice.phone}.`;

          logger.info('WhatsApp message', {
            whatsappMessage
          });

          const whatsappResponse = await whatsappService.sendWhatsAppTemplateMessage(booking.receiverPhone, this.booking_confirmed, attributes, mediaId, operatorConfig);
          if (whatsappResponse.success) {
            logger.info('WhatsApp message sent successfully', {
              bookingId: booking.bookingId,
              userId,
              lrType: booking.lrType,
              status: booking.status,
              whatsappResponse
            });
            const response = await whatsappService.saveWhatsAppConversations(whatsappMessage, booking, whatsappResponse, WhatsAppConversation.CARGO_BOOKING_TYPE, operatorConfig);
            logger.info(response.message);
          }
        }
      }

    } catch (error) {
      logger.error('Error confirming booking', {
        error: error.message,
        bookingId: booking._id,
        userId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async updateBooking(id, updateData, operatorId, currentUserId) {
    logger.info('Updating booking', {
      bookingId: id,
      operatorId,
      updateFields: Object.keys(updateData)
    });

    try {
      const booking = await Booking.findOne(
        appendOperatorFilter({ _id: id }, operatorId)
      ).populate('fromOffice', 'name phone address').populate('toOffice', 'name phone address');

      if (!booking) {
        logger.warn('Booking not found for update', { bookingId: id, operatorId });
        throw new Error('Booking not found');
      }

      // Fetch current user's branchId
      const user = await User.findById(currentUserId).select('branchId');
      if (!user) throw new Error('User not found');
      if (!user.branchId) throw new Error('User branch not assigned');

      const newStatus = updateData.status;
      const now = new Date();

      // Map status to event type
      const statusToEventMap = {
        InTransit: 'loaded',
        Arrived: 'unloaded',
        Cancelled: 'cancelled'
      };

      const eventType = statusToEventMap[newStatus];

      if (eventType) {
        booking.eventHistory.push({
          type: eventType,
          user: currentUserId,
          date: now,
          vehicle: updateData.assignedVehicle || booking.assignedVehicle || null,
          branch: user.branchId
        });
      }

      // Update assignedVehicle if changed or newly assigned
      if (updateData.assignedVehicle && (!booking.assignedVehicle || booking.assignedVehicle.toString() !== updateData.assignedVehicle)) {
        booking.assignedVehicle = updateData.assignedVehicle;
      }

      // Apply other updates from updateData
      Object.assign(booking, updateData);
      booking.updatedAt = now;

      await booking.save();

      logger.info('Successfully updated booking', {
        bookingId: id,
        newStatus: booking.status,
        operatorId,
        updatedBy: currentUserId
      });

      if (eventType === 'unloaded' && config.WHATSAPP_ENABLED === 'true') {
        const attributes = [booking.receiverName, booking.bookingId, `${booking.toOffice.address} Phone: ${booking.toOffice.phone}`];

        const whatsAppMessage = `Dear ${booking.receiverName} your package with LR NO: ${booking.bookingId} has arrived at our office location : ${booking.toOffice.address} Phone: ${booking.toOffice.phone}. You can pick the package at your convenience.`;

        /*Dear {{1}} your package with LR NO: {{2}} has arrived at our office location : {{3}}. You can pick the package at your convenience.*/

        const operator = await Operator.findById(operatorId);
        const operatorConfig = operator?.whatsappConfig || {};

        const whatsappResponse = await whatsappService.sendWhatsAppTemplateMessage(booking.receiverPhone, this.booking_arrived, attributes, null, operatorConfig);
        if (whatsappResponse.success) {
          logger.info('WhatsApp message sent successfully', {
            bookingId: booking.bookingId,
            currentUserId,
            lrType: booking.lrType,
            status: booking.status,
            whatsappResponse
          });
          const response = await whatsappService.saveWhatsAppConversations(whatsAppMessage, booking, whatsappResponse, WhatsAppConversation.CARGO_BOOKING_TYPE, operatorConfig);
          logger.info(response.message);
        }
      }

      return booking;
    } catch (error) {
      logger.error('Error updating booking', {
        error: error.message,
        bookingId: id,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async multipleBookings(updateData, operatorId, currentUserId) {
    logger.info('Updating bookings', {
      bookings: updateData.bookings,
      operatorId,
      updateFields: Object.keys(updateData)
    });

    try {
      const bookings = await Booking.find(
        appendOperatorFilter({ _id: { $in: updateData.bookings } }, operatorId)
      ).populate('fromOffice', 'name phone address').populate('toOffice', 'name phone address');

      if (bookings.length !== updateData.bookings.length) {
        logger.warn('Some bookings not found for update', {
          bookings: updateData.bookings,
          operatorId
        });
        throw new Error('Some bookings not found');
      }

      // Fetch current user's branchId
      const user = await User.findById(currentUserId).select('branchId');
      if (!user) throw new Error('User not found');
      if (!user.branchId) throw new Error('User branch not assigned');

      const now = new Date();

      // Map status to event type
      const statusToEventMap = {
        InTransit: 'loaded',
        Arrived: 'unloaded',
        Cancelled: 'cancelled'
      };

      const eventType = statusToEventMap[updateData.status];

      if (eventType) {
        bookings.forEach(booking => {
          booking.eventHistory.push({
            type: eventType,
            user: currentUserId,
            date: now,
            vehicle: updateData.assignedVehicle || booking.assignedVehicle || null,
            branch: user.branchId
          });
        });
      }

      // Update assignedVehicle if changed or newly assigned
      bookings.forEach(booking => {
        if (updateData.assignedVehicle && (!booking.assignedVehicle || booking.assignedVehicle.toString() !== updateData.assignedVehicle)) {
          booking.assignedVehicle = updateData.assignedVehicle;
        }
      });

      // Apply other updates from updateData
      bookings.forEach(booking => {
        Object.assign(booking, updateData);
        booking.updatedAt = now;
      });

      await Promise.all(bookings.map(booking => booking.save()));

      logger.info('Successfully updated bookings', {
        bookings: updateData.bookings,
        newStatus: updateData.status,
        operatorId,
        updatedBy: currentUserId
      });

      if (eventType === 'unloaded' && config.WHATSAPP_ENABLED === 'true') {
        const operator = await Operator.findById(operatorId);
        const operatorConfig = operator?.whatsappConfig || {};

        const promises = bookings.map(booking => {
          const attributes = [booking.receiverName, booking.bookingId, `${booking.toOffice.address} Phone: ${booking.toOffice.phone}`];

          const whatsAppMessage = `Dear ${booking.receiverName} your package with LR NO: ${booking.bookingId} has arrived at our office location : ${booking.toOffice.address} Phone: ${booking.toOffice.phone}. You can pick the package at your convenience.`;

          /*Dear {{1}} your package with LR NO: {{2}} has arrived at our office location : {{3}}. You can pick the package at your convenience.*/

          return whatsappService.sendWhatsAppTemplateMessage(booking.receiverPhone, this.booking_arrived, attributes, null, operatorConfig).then(whatsappResponse => {
            if (whatsappResponse.success) {
              logger.info('WhatsApp message sent successfully', {
                bookingId: booking.bookingId,
                currentUserId,
                lrType: booking.lrType,
                status: booking.status,
                whatsappResponse
              });
              return whatsappService.saveWhatsAppConversations(whatsAppMessage, booking, attributes, WhatsAppConversation.CARGO_BOOKING_TYPE, operatorConfig);
            }
          });
        });

        await Promise.all(promises);
      }

      return bookings;
    } catch (error) {
      console.log(error);
      logger.error('Error updating bookings', {
        error: error.message,
        bookings: updateData.bookings,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async deleteBooking(id, operatorId) {
    logger.info('Deleting booking', { bookingId: id, operatorId });

    try {
      const booking = await Booking.findOneAndDelete(appendOperatorFilter({ _id: id }, operatorId));
      if (!booking) {
        logger.warn('Booking not found for deletion', { bookingId: id, operatorId });
        throw new Error('Booking not found');
      }

      logger.info('Successfully deleted booking', { bookingId: id, operatorId });
      return { message: 'Booking deleted' };
    } catch (error) {
      logger.error('Error deleting booking', {
        error: error.message,
        bookingId: id,
        operatorId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async getUnassignedBookings(operatorId, page = 1, limit = 10, query = "", branchIds = [], status = "") {
    logger.info('Fetching unassigned bookings', {
      operatorId,
      branchIds,
      page,
      limit,
      query: query || 'none'
    });

    try {
      const skip = (page - 1) * limit;
      const validBranchIds = (branchIds || []).filter(id => mongoose.Types.ObjectId.isValid(id));
      const baseFilter = appendOperatorFilter({
        status: { $in: status ? [status] : ["Booked", "InTransit"] },
        ...(validBranchIds.length > 0 && {
          $or: validBranchIds.map(branchId => ({
            fromOffice: branchId
          }))
        })
      }, operatorId);

      if (query?.trim()) {
        const regex = new RegExp(query.trim(), 'i');
        baseFilter.$or = [
          { bookingId: regex },
          { senderName: regex },
          { receiverName: regex },
        ];
        logger.debug('Applied search filter', { filter: baseFilter.$or });
      }

    const [total, rawBookings] = await Promise.all([
      Booking.countDocuments(baseFilter),
      Booking.find(baseFilter)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .populate('fromOffice', 'name')
        .populate('toOffice', 'name')
        .populate('bookedBy', '_id fullName')
        .populate('operatorId', '_id')
        .populate('assignedVehicle', '_id vehicleNumber')
      ]);

      // Format bookings
      const bookings = rawBookings.map(b => {
        const bookingObj = b.toObject();

        // bookedBy as string _id or null
        bookingObj.bookedBy = {
          _id: b.bookedBy?._id?.toString() || null,
          fullName: b.bookedBy?.fullName
        };

        // operatorId as string _id or null
        bookingObj.operatorId = b.operatorId?._id?.toString() || null;

        // assignedVehicle as simplified object or null
        bookingObj.assignedVehicle = b.assignedVehicle
          ? {
              _id: b.assignedVehicle._id.toString(),
              vehicleNumber: b.assignedVehicle.vehicleNumber,
            }
          : null;

        return bookingObj;
      });

      const result = {
        bookings,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        count: bookings.length,
      };

      logger.info('Successfully fetched unassigned bookings', {
        total,
        returned: bookings.length,
        operatorId,
        page,
        totalPages: result.totalPages
      });

      return result;
    } catch (error) {
      logger.error('Error getting unassigned bookings', {
        error: error.message,
        operatorId,
        page,
        limit,
        query: query || 'none',
        stack: error.stack
      });
      throw error;
    }
  }

  static async getAssignedBookings(operatorId, page = 1, limit = 10, query = "") {
    logger.info('Fetching assigned bookings', {
      operatorId,
      page,
      limit,
      query: query || 'none'
    });

    try {
      const skip = (page - 1) * limit;
      const baseFilter = appendOperatorFilter({
        assignedVehicle: { $ne: null },
      }, operatorId);

      if (query?.trim()) {
        const regex = new RegExp(query.trim(), 'i');
        baseFilter.$or = [
          { bookingId: regex },
          { senderName: regex },
          { receiverName: regex },
        ];
        logger.debug('Applied search filter', { filter: baseFilter.$or });
      }

    const [total, rawBookings] = await Promise.all([
      Booking.countDocuments(baseFilter),
      Booking.find(baseFilter)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .populate('fromOffice', '_id name')
        .populate('toOffice', '_id name')
        .populate('operatorId', '_id')
        .populate('assignedVehicle', '_id vehicleNumber')
        .populate('bookedBy', '_id fullName')
      ]);

      const bookings = rawBookings.map(b => {
        const booking = b.toObject();

        booking.bookedBy = {
          _id: b.bookedBy ? b.bookedBy.toString() : null,
          fullName: b.bookedBy?.fullName
        };

        booking.operatorId = b.operatorId?._id?.toString() || null;

        booking.assignedVehicle = b.assignedVehicle
          ? {
              _id: b.assignedVehicle._id.toString(),
              vehicleNumber: b.assignedVehicle.vehicleNumber,
            }
          : null;

        return booking;
      });

      const result = {
        bookings,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        count: bookings.length,
      };

      logger.info('Successfully fetched assigned bookings', {
        total,
        returned: bookings.length,
        operatorId,
        page,
        totalPages: result.totalPages,
        updatedToInTransit: updateResult?.modifiedCount || 0
      });

      return result;
    } catch (error) {
      logger.error('Error getting assigned bookings', {
        error: error.message,
        operatorId,
        page,
        limit,
        query: query || 'none',
        stack: error.stack
      });
      throw error;
    }
  }

  static async getInTransitBookings(operatorId, userId, page = 1, limit = 10, query = "", branchIds = [], status = "") {
    logger.info('Fetching in-transit bookings', {
      operatorId,
      branchIds,
      userId,
      page,
      limit,
      query: query || 'none'
    });

    try {
      const skip = (page - 1) * limit;
      const validBranchIds = (branchIds || []).filter(id => mongoose.Types.ObjectId.isValid(id));
      const baseFilter = appendOperatorFilter({
        status: { $in: status ? [status] : ['InTransit', 'Booked', 'Arrived'] },
        ...(validBranchIds.length > 0 && {
          $or: validBranchIds.map(branchId => ({
            fromOffice: branchId
          }))
        })
      }, operatorId);

      if (query?.trim()) {
        const regex = new RegExp(query.trim(), 'i');
        baseFilter.$or = [
          { bookingId: regex },
          { senderName: regex },
          { receiverName: regex }
        ];
        logger.debug('Applied search filter', { filter: baseFilter.$or });
      }

    const [total, rawBookings] = await Promise.all([
      Booking.countDocuments(baseFilter),
      Booking.find(baseFilter)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .populate('fromOffice', '_id name')
        .populate('toOffice', '_id name')
        .populate('assignedVehicle', '_id vehicleNumber')
        .populate('operatorId', '_id')
        .populate('bookedBy', '_id fullName')
      ]);

      const bookings = rawBookings.map(b => {
        const booking = b.toObject();

        booking.bookedBy = {
          _id: b.bookedBy ? b.bookedBy.toString() : null,
          fullName: b.bookedBy?.fullName
        };
        booking.operatorId = b.operatorId?._id?.toString() || null;

        booking.assignedVehicle = b.assignedVehicle
          ? {
              _id: b.assignedVehicle._id.toString(),
              vehicleNumber: b.assignedVehicle.vehicleNumber,
            }
          : null;

        return booking;
      });

      const result = {
        bookings,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        count: bookings.length,
      };

      logger.info('Successfully fetched in-transit bookings', {
        total,
        returned: bookings.length,
        operatorId,
        page,
        totalPages: result.totalPages
      });

      return result;
    } catch (error) {
      logger.error('Error getting in-transit bookings', {
        error: error.message,
        operatorId,
        page,
        limit,
        query: query || 'none',
        stack: error.stack
      });
      throw error;
    }
  }

  static async getArrivedBookings(operatorId, userId, page = 1, limit = 10, query = "", branchIds = [], status = "") {
    logger.info('Fetching arrived bookings', {
      operatorId,
      branchIds,
      userId,
      page,
      limit,
      query: query || 'none'
    });

    try {
      const skip = (page - 1) * limit;

      const opId = operatorId && mongoose.Types.ObjectId.isValid(operatorId)
        ? new mongoose.Types.ObjectId(operatorId)
        : operatorId;

      const validBranchIds = (branchIds || []).filter(id => mongoose.Types.ObjectId.isValid(id));
      const baseFilter = appendOperatorFilter({
        status: { $in: status ? [status] : ['Arrived', 'Booked', 'InTransit'] },
        ...(validBranchIds.length > 0 && {
          $or: validBranchIds.map(branchId => ({
            fromOffice: branchId
          }))
        })
      }, opId);

      if (query?.trim()) {
        const regex = new RegExp(query.trim(), 'i');
        baseFilter.$or = [
          { bookingId: regex },
          { senderName: regex },
          { receiverName: regex }
        ];
        logger.debug('Applied search filter', { filter: baseFilter.$or });
      }

    logger.info('Fetching arrived bookings with filter:', baseFilter);

    const [total, rawBookings] = await Promise.all([
      Booking.countDocuments(baseFilter),
      Booking.find(baseFilter)
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .populate('fromOffice', '_id name')
        .populate('toOffice', '_id name')
        .populate('assignedVehicle', '_id vehicleNumber')
        .populate('operatorId', '_id name')
        .populate('bookedBy', '_id fullName')
      ]);

      logger.debug('Fetched arrived bookings', { total, limit, skip });

      const formattedBookings = rawBookings.map(b => {
        const booking = b.toObject();

        booking.bookedBy = {
          _id: b.bookedBy ? b.bookedBy.toString() : null,
          fullName: b.bookedBy?.fullName
        };

        booking.operatorId = b.operatorId?._id?.toString() || null;

        booking.assignedVehicle = b.assignedVehicle
          ? {
              _id: b.assignedVehicle._id.toString(),
              vehicleNumber: b.assignedVehicle.vehicleNumber,
            }
          : null;

        return booking;
      });

      const result = {
        bookings: formattedBookings,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        count: formattedBookings.length,
      };

      logger.info('Successfully fetched arrived bookings', {
        total,
        returned: formattedBookings.length,
        operatorId,
        page,
        totalPages: result.totalPages
      });

      return result;
    } catch (error) {
      logger.error('Error fetching arrived bookings', {
        error: error.message,
        operatorId,
        page,
        limit,
        query: query || 'none',
        stack: error.stack
      });
      throw error;
    }
  }

  static async searchBookings({ operatorId, limit = 10, page = 1, query = "", status = "" }) {
    logger.info('Searching bookings', {
      operatorId,
      query: query || 'none',
      status: status || 'all',
      page,
      limit
    });

    try {
      const mongoQuery = buildOperatorFilter(operatorId);

    if (query.trim()) {
      const regex = new RegExp(query.trim(), "i");
      mongoQuery.$or = [
        { bookingId: regex },
        { senderName: regex },
        { receiverName: regex },
      ];
    }

    if (status.trim()) {
      // Case-insensitive exact match for status using regex
      const statusRegex = new RegExp(`^${status.trim()}$`, "i");
      mongoQuery.status = statusRegex;
    }

    console.log("MongoDB query:", JSON.stringify(mongoQuery, null, 2));

      const skip = (parseInt(page) - 1) * parseInt(limit);

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(mongoQuery),
      Booking.find(mongoQuery)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 })
        .populate({ path: "fromOffice", select: "_id name" })
        .populate({ path: "toOffice", select: "_id name" })
        .populate({ path: "assignedVehicle", select: "_id vehicleNumber" })
        .populate({ path: "bookedBy", select: "_id fullName" })
    ]);

    const formattedBookings = bookings.map((booking) => {
      const b = booking.toObject();
      if (b.assignedVehicle?.vehicleNumber) {
        b.assignedVehicle = {
          _id: b.assignedVehicle._id,
          assignedVehicle: b.assignedVehicle.vehicleNumber,
        };
      }
      return b;
    });

      const result = {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        bookings: formattedBookings,
      };

      logger.debug('Booking search completed', {
        totalResults: total,
        returnedResults: formattedBookings.length,
        operatorId
      });

      return result;
    } catch (error) {
      logger.error('Error searching bookings', {
        error: error.message,
        operatorId,
        query,
        status,
        stack: error.stack
      });
      throw error;
    }
  }

  static async markAsDelivered(booking, userId, updateData = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      // Apply updates
      if (updateData.status) booking.status = updateData.status;
      if (updateData.paymentType) booking.paymentType = updateData.paymentType;
      booking.deliveredBy = userId;

      let finalUser = user;
      if(booking.lrType === 'ToPay') {
        const amount = booking.totalAmountCharge || 0;
        const { user: updatedUser, oldBalance, newBalance } = await UserService.addToCargoBalance(userId, amount);
        finalUser = updatedUser;

        await Transaction.create({
          user: userId,
          amount: amount,
          oldBalance,
          balanceAfter: newBalance,
          type: 'Delivered',
          referenceId: booking._id,
          description: `Cargo balance updated from delivery (${updateData.paymentType} payment): ${booking.bookingId} for amount: ${amount}`  
        
        });
      }

      await booking.save();

      logger.info('Booking marked as delivered', {
        bookingId: booking._id,
        userId,
        paymentType: updateData.paymentType,
        status: updateData.status,
        amount: booking.totalAmountCharge,
        updatedBalance: finalUser.cargoBalance
      });

    } catch (error) {
      logger.error('Error marking booking as delivered', {
        error: error.message,
        bookingId: booking._id,
        userId,
        stack: error.stack
      });
      throw error;
    }
  }

  static async getContactByPhone(operatorId, phoneNumber) {
    logger.info('Fetching contact by phone', { operatorId, phoneNumber });

    try {
      // Search bookings for sender or receiver matching the phoneNumber under operatorId
      const booking = await Booking.findOne(
        appendOperatorFilter({
          $or: [
            { senderPhone: phoneNumber },
            { receiverPhone: phoneNumber }
          ]
        }, operatorId)
      );

      if (!booking) {
        return null;
      }

      // Determine if phone matches sender or receiver and prepare result accordingly
      let contact = null;

      if (booking.senderPhone === phoneNumber) {
        contact = {
          name: booking.senderName,
          email: booking.senderEmail || '',   // if available
          address: booking.senderAddress || '',
          phone: booking.senderPhone
        };
      } else if (booking.receiverPhone === phoneNumber) {
        contact = {
          name: booking.receiverName,
          email: booking.receiverEmail || '',  // if available
          address: booking.receiverAddress || '',
          phone: booking.receiverPhone
        };
      }

      logger.info('Contact fetched successfully', { contact });

      return contact;
    } catch (error) {
      logger.error('Error fetching contact by phone', {
        error: error.message,
        operatorId,
        phoneNumber,
        stack: error.stack,
      });
      throw error;
    }
  }
}

module.exports = BookingService;

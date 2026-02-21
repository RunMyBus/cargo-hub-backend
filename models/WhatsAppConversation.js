const mongoose = require('mongoose');
const applyOperatorScope = require('../utils/mongooseOperatorScope');
const { schema: whatsappMessageSchema } = require('./WhatsAppMessage');

const whatsappConversationSchema = new mongoose.Schema({
  phoneNumber: { type: String, index: true },
  from: { type: String, index: true },
  replyPending: { type: Boolean, default: false },
  pnrs: { type: Array, default: [] },
  fromCities: { type: [String], default: [] },
  toCities: { type: [String], default: [] },
  messages: [whatsappMessageSchema],
  travelDates: { type: [String], default: [] },
  serviceNumbers: { type: [String], default: [] },
  referenceType: { type: String },
  complaint: { type: Boolean, default: false },
  name: { type: String },
  lastMessage: { type: String },
  lastMessageDateTime: { type: Date },
  lastSentMessageId: { type: String, index: true }, // ncmessage_id of the last outgoing template
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Operator' },
}, {
  timestamps: true
});

whatsappConversationSchema.plugin(applyOperatorScope);

whatsappConversationSchema.statics.CARGO_BOOKING_TYPE = "CargoBooking";
whatsappConversationSchema.statics.BOOKING_FEEDBACK = "BookingFeedback";

module.exports = mongoose.model('WhatsAppConversation', whatsappConversationSchema);

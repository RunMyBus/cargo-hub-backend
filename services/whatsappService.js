const axios = require('axios');
const config = process.env;
const logger = require('../utils/logger');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const WhatsAppConversation = require('../models/WhatsAppConversation');

const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

let API_URL = config.WHATSAPP_MESSAGE_URL;
let MEDIA_API_URL = config.WHATSAPP_MEDIA_URL;
let CONVO_API_URL = config.WHATSAPP_CONVERSATION_URL;

// Helper to get effective config
const getEffectiveConfig = (operatorConfig) => {
    return {
        apiKey: operatorConfig?.apiKey || config.WHATSAPP_API_TOKEN,
        phoneNumber: operatorConfig?.phoneNumber || config.NETCORE_PHONE_NUMBER,
        feedbackTemplateName: operatorConfig?.feedbackTemplateName || config.FEEDBACK_REQUEST
    };
};

/**
 * Format phone number
 * @param {string} phoneNumber - Phone number
 * @returns {string} - Formatted phone number
 */
function formatPhoneNumber(phoneNumber) {
    logger.info('Formatting phone number', {
        phoneNumber
    });
    if (!phoneNumber) return '';
    if (phoneNumber.length === 10) {
        phoneNumber = '91' + phoneNumber;
    }
    if (phoneNumber.length === 12 && phoneNumber.startsWith('91')) {
        return phoneNumber;
    }
    if (phoneNumber.length > 10 && !phoneNumber.startsWith('91')) {
        throw new Error(`Invalid phone number ${phoneNumber}`);
    }
    if (phoneNumber.length < 10) {
        throw new Error(`Invalid phone number ${phoneNumber}`);
    }
    return phoneNumber;
}

/**
 * Send WhatsApp template message using NETCORE ( PEPISPOST )
 * @param {string} mobile - Mobile number
 * @param {string} templateName - Template name
 * @param {Array} attributes - Template attributes should be passed in specified template order only
 * @param {string} mediaId - Media ID
 * @param {object} operatorConfig - Operator specific whatsapp config
 * @returns {Promise<object>} - Response from WhatsApp API
 */
async function sendWhatsAppTemplateMessage(mobile, templateName, attributes, mediaId, operatorConfig = {}) {
    logger.info('Sending WhatsApp template message', {
        mobile,
        templateName,
        attributes
    });

    const effectiveConfig = getEffectiveConfig(operatorConfig);
    const API_KEY = effectiveConfig.apiKey;

    const payload = {
        message: [
            {
                recipient_whatsapp: formatPhoneNumber(mobile),
                message_type: mediaId ? "media_template" : "template",
                recipient_type: "individual",
                type_template: [
                    {
                        name: templateName,
                        attributes: attributes,
                        language: {
                            locale: "en",
                            policy: "deterministic"
                        }
                    }
                ]
            }
        ]
    }

    // If mediaId exists, add type_media_template
    if (mediaId) {
        payload.message[0].type_media_template = {
            type: "document",
            media_id: mediaId
        };
    }

    try {
        const response = await axios.post(API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200 || response.data.status.toLowerCase() !== 'success') {
            logger.error(`Failed to send WhatsApp message: ${response.data}`);
            return { success: false, error: response.data };
        }

        return { success: true, data: response.data };
    } catch (error) {
        logger.error(`Failed to send WhatsApp message: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Saves WhatsApp conversation and message
 * @param {string} message - The WhatsApp message content
 * @param {object} bookingReferenceData - The cargo booking object
 * @param {object} response - Response from WhatsApp API
 * @param {string} bookingReference - Reference type constant
 * @param {object} operatorConfig - Operator specific whatsapp config
 * @param {string|null} lastSentMessageId - ncmessage_id from the API response, stored for reply matching
 * @returns {Promise<object>} - Promise that resolves with success/error status
 */
async function saveWhatsAppConversations(message, bookingReferenceData, response, bookingReference, operatorConfig = {}, lastSentMessageId = null) {
    logger.info('Saving WhatsApp conversation', {
        message,
        bookingId: bookingReferenceData?.id,
        hasResponse: !!response,
        bookingReference: bookingReference,
        lastSentMessageId
    });

    const effectiveConfig = getEffectiveConfig(operatorConfig);
    const SENDER_PHONE = effectiveConfig.phoneNumber;

    try {
        const whatsAppMessage = new WhatsAppMessage.model({
            message,
            incoming: false,
            response: JSON.stringify(response),
            sentAt: new Date(),
            bookingId: bookingReferenceData?.id,
            operatorId: bookingReferenceData?.operatorId
        });

        const phoneNumber = formatPhoneNumber(bookingReferenceData.receiverPhone?.toString());

        const existingConversation = await WhatsAppConversation.findOne({
            phoneNumber,
            referenceType: bookingReference,
            operatorId: bookingReferenceData?.operatorId
        });

        if (existingConversation) {
            existingConversation.messages.push(whatsAppMessage);
            if (bookingReferenceData?.pnr) existingConversation.pnrs.push(bookingReferenceData.pnr);
            if (bookingReferenceData?.fromCity) existingConversation.fromCities.push(bookingReferenceData.fromCity);
            if (bookingReferenceData?.toCity) existingConversation.toCities.push(bookingReferenceData.toCity);
            if (bookingReferenceData?.travelDates) existingConversation.travelDates.push(bookingReferenceData.travelDates);
            if (lastSentMessageId) existingConversation.lastSentMessageId = lastSentMessageId;
            await existingConversation.save();
        } else {
            const pnrs = [];
            const fromCities = [];
            const toCities = [];
            const travelDates = [];
            if (bookingReferenceData?.pnr) pnrs.push(bookingReferenceData.pnr);
            if (bookingReferenceData?.fromCity) fromCities.push(bookingReferenceData.fromCity);
            if (bookingReferenceData?.toCity) toCities.push(bookingReferenceData.toCity);
            if (bookingReferenceData?.travelDates) travelDates.push(bookingReferenceData.travelDates);
            const newConversation = new WhatsAppConversation({
                name: bookingReferenceData.receiverName,
                messages: [ whatsAppMessage ],
                phoneNumber,
                from: SENDER_PHONE,
                pnrs,
                fromCities,
                toCities,
                travelDates,
                replyPending: false,
                operatorId: bookingReferenceData?.operatorId,
                referenceType: bookingReference,
                lastSentMessageId: lastSentMessageId || null
            });
            await newConversation.save();
        }

        await whatsAppMessage.save();
        return { success: true, message: 'WhatsApp conversation saved successfully' };
    } catch (error) {
        logger.error(`Failed to save WhatsApp conversation: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function uploadPDF(bookingId, pdfBuffer, operatorConfig = {}) {
    const effectiveConfig = getEffectiveConfig(operatorConfig);
    const API_KEY = effectiveConfig.apiKey;

    try {
        // Create a temporary file
        const tempFilePath = path.join('/tmp', `${bookingId}.pdf`);
        fs.writeFileSync(tempFilePath, pdfBuffer);
        
        // Create form data
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), {
            filename: `${bookingId}.pdf`,
            contentType: 'application/pdf',
            knownLength: pdfBuffer.length
        });

        // Get headers from form data
        const formHeaders = form.getHeaders();

        // Send POST request
        const response = await axios.post(`${MEDIA_API_URL}/upload/`, form, {
            headers: {
                ...formHeaders,
                'Authorization': `Bearer ${API_KEY}`,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        // Clean up temporary file
        fs.unlinkSync(tempFilePath);

        if (response.status !== 200 || response.data.status.toLowerCase() !== 'success') {
            logger.error("Media Upload failed:", response.data);
            return { success: false, error: response.data };
        }

        logger.info("Media Upload success:", response.data);
        return { 
            success: true, 
            mediaId: response.data.data.mediaId 
        };
    } catch (error) {
        logger.error("Media Upload failed:", {
            message: error.message,
            response: error.response?.data
        });
        return { 
            success: false, 
            error: error.response?.data?.message || error.message 
        };
    }
}

/**
 * Send WhatsApp text message using NETCORE
 * @param {string} mobile - Mobile number
 * @param {string} content - Message content
 * @param {object} operatorConfig - Operator specific whatsapp config
 * @returns {Promise<object>} - Response from WhatsApp API
 */
async function sendWhatsAppTextMessage(mobile, content, operatorConfig = {}) {
    logger.info(`Sending WhatsApp text message`, { mobile });

    const effectiveConfig = getEffectiveConfig(operatorConfig);
    const API_KEY = effectiveConfig.apiKey;

    const payload = {
        message: [
            {
                recipient_whatsapp: formatPhoneNumber(mobile),
                recipient_type: "individual",
                message_type: "text",
                type_text: [
                    {
                        content: content
                    }
                ]
            }
        ]
    };

    try {
        const response = await axios.post(CONVO_API_URL, payload, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200 || (response.data.status && response.data.status.toLowerCase() !== 'success')) {
            logger.error(`Failed to send WhatsApp text message: ${JSON.stringify(response.data)}`);
            return { success: false, error: response.data?.error || response.data };
        }

        return { success: true, data: response.data };
    } catch (error) {
        logger.error(`Failed to send WhatsApp text message: ${error.message}`);
        return { success: false, error: error.message };
    }
}

module.exports = {
    sendWhatsAppTemplateMessage,
    saveWhatsAppConversations,
    uploadPDF,
    sendWhatsAppTextMessage
};

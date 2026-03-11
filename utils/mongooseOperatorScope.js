const mongoose = require('mongoose');
const requestContext = require('./requestContext');

const QUERY_HOOKS = [
    'count',
    'countDocuments',
    'deleteMany',
    'deleteOne',
    'find',
    'findOne',
    'findOneAndDelete',
    'findOneAndRemove',
    'findOneAndUpdate',
    'remove',
    'update',
    'updateOne',
    'updateMany'
];

const toObjectId = (value) => {
    if (!value) {
        return null;
    }
    if (value instanceof mongoose.Types.ObjectId) {
        return value;
    }
    if (mongoose.Types.ObjectId.isValid(value)) {
        return new mongoose.Types.ObjectId(value);
    }
    return null;
};

module.exports = function operatorScope(schema) {
    if (!schema.path('operatorId')) {
        return;
    }

    const applyOperatorFilter = function () {
        const existingFilter = this.getFilter();
        if (requestContext.isSuperUser()) {
            // If caller explicitly passed operatorId (e.g. SuperUser filtering by a specific
            // operator from the request payload), leave it intact.
            const isExplicit = this.getOptions()._explicitOperatorId;
            if (!isExplicit && existingFilter && Object.prototype.hasOwnProperty.call(existingFilter, 'operatorId')) {
                delete existingFilter.operatorId;
            }
            return;
        }
        const operatorId = toObjectId(requestContext.getOperatorId());
        if (!operatorId) {
            return;
        }

        if (existingFilter && Object.prototype.hasOwnProperty.call(existingFilter, 'operatorId')) {
            return;
        }

        this.where({ operatorId });
    };

    QUERY_HOOKS.forEach((hook) => {
        schema.pre(hook, function (next) {
            applyOperatorFilter.call(this);
            next();
        });
    });

    schema.pre('aggregate', function (next) {
        const pipeline = this.pipeline();
        if (requestContext.isSuperUser()) {
            pipeline.forEach((stage) => {
                if (stage.$match && Object.prototype.hasOwnProperty.call(stage.$match, 'operatorId')) {
                    delete stage.$match.operatorId;
                }
            });
            return next();
        }
        const operatorId = toObjectId(requestContext.getOperatorId());
        if (!operatorId) {
            return next();
        }

        pipeline.unshift({ $match: { operatorId } });
        next();
    });
};

const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const Branch = require('../models/Branch');
const bcrypt = require('bcryptjs');
const requestContext = require('../utils/requestContext');
const logger = require('../utils/logger');

class UserService {
  /**
   * Get all users for an operator (or all if SuperUser)
   * @param {string} operatorId - The operator ID
   * @param {string} userRole - Current user's role name
   * @returns {Promise<Array>} List of users
   */
  static async getUsers(operatorId, userRole) {
    logger.info('Fetching all users', { operatorId, userRole });

    const isSuperUser = userRole === 'SuperUser';
    if (!operatorId && !isSuperUser) {
      logger.error('Operator ID is required for fetching users');
      throw new Error('Operator ID is required');
    }

    try {
      const query = isSuperUser ? {} : { operatorId };
      const users = await User.find(query)
        .populate('role')
        .populate('operatorId', '_id name')
        .populate('branchId', '_id name');

      logger.info('Successfully fetched users', {
        count: users.length,
        operatorId,
        isSuperUser
      });

      return users;
    } catch (error) {
      logger.error('Error fetching users', {
        error: error.message,
        operatorId,
        userRole,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get user balances for an operator (or all if SuperUser)
   * @param {string} operatorId - The operator ID
   * @param {string} userRole - Current user's role name
   * @returns {Promise<Array>} List of user balances
   */
  static async getUserBalances(operatorId, userRole) {
    logger.info('Fetching user balances', { operatorId, userRole });

    const isSuperUser = userRole === 'SuperUser';
    if (!operatorId && !isSuperUser) {
      logger.error('Operator ID is required for fetching user balances');
      throw new Error('Operator ID is required');
    }

    try {
      const query = isSuperUser ? {} : { operatorId };
      //get all users with cargoBalance greater than 0 and sort by cargoBalance in descending order 
      const users = await User.find(query).
      where('cargoBalance').gt(0).select('fullName cargoBalance');

      return users.map(user => ({
        userId: user._id.toString(),
        fullName: user.fullName,
        cargoBalance: user.cargoBalance || 0
      }));
    } catch (error) {
      logger.error('Error fetching user balances', {
        error: error.message,
        operatorId,
        userRole,
        stack: error.stack
      });
      throw error;
    }
  }
  /**
   * Get all users for an operator
   * @param {string} operatorId - The operator ID
   * @param {string} userRole - Current user's role name
   * @returns {Promise<Array>} List of users
   */
  static async getUserNameByOperator(operatorId, userRole) {
    logger.info('Fetching users', { operatorId, userRole });
    
    const isSuperUser = userRole === 'SuperUser';
    
    if (!operatorId && !isSuperUser) {
      logger.error('Operator ID is required for fetching users');
      throw new Error('Operator ID is required');
    }
    
    try {
      // For SuperUser, fetch all users; otherwise filter by operatorId
      const query = isSuperUser ? {} : { operatorId };
      const users = await User.find(query).select('fullName');
      logger.info('Successfully fetched users', { count: users.length, operatorId, isSuperUser });
      return users;
    } catch (error) {
      logger.error('Error fetching users', { error: error.message, operatorId, userRole, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get user by ID
   * @param {string} id - User ID
   * @returns {Promise<Object>} User details
   */
 static async getUserById(id) {
  logger.info('Fetching user by ID', { userId: id });

  try {
    const user = await User.findById(id)
      .populate('role')
      .populate('branchId', 'name')       
      .populate('operatorId', 'name');    

    if (!user) {
      logger.warn('User not found', { userId: id });
      throw new Error('User not found');
    }

    logger.debug('Successfully fetched user', {
      userId: id,
      role: user.role?.name,
      branch: user.branchId?.name,
      operator: user.operatorId?.name,
    });

    return {
      ...user.toObject(),
      branchName: user.branchId?.name || null,
      operatorName: user.operatorId?.name || null,
    };
  } catch (error) {
    logger.error('Error fetching user by ID', {
      error: error.message,
      userId: id,
      stack: error.stack,
    });
    throw error;
  }
}

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @returns {Promise<Object>} Created user
   */
  static async createUser(userData, currentOperatorId, createdBy) {
    const { mobile, role, branchId } = userData;
    logger.info('Creating new user', {
      mobile,
      role,
      operatorId: userData.operatorId || currentOperatorId,
      createdBy
    });

    try {
      // Check if mobile number exists
      const existingUser = await User.findOne({ mobile });
      if (existingUser) {
        logger.warn('Mobile number already exists', { mobile });
        throw new Error('Mobile number already exists');
      }

      // Validate role
      const roleExists = await Role.findById(role);
      if (!roleExists) {
        logger.warn('Invalid role ID provided', { role });
        throw new Error('Invalid role ID');
      }

      // Validate branch if provided
      if (branchId) {
        const branchExists = await Branch.findById(branchId);
        if (!branchExists) {
          logger.warn('Invalid branch ID provided', { branchId });
          throw new Error('Invalid branch ID');
        }
      }

      // Determine operatorId
      const operatorIdToUse = userData.operatorId || currentOperatorId;
      if (!operatorIdToUse) {
        throw new Error('Operator ID is required');
      }

      // Format status
      const status = userData.status?.charAt(0).toUpperCase() +
                    (userData.status?.slice(1).toLowerCase() || '');

  
      // Create user
      const newUser = new User({
        ...userData,
        status: status || 'Active',
        operatorId: operatorIdToUse,
        createdBy: createdBy || null,
        cargoBalance: 0,
      });

      const savedUser = await newUser.save();

      logger.info('User created successfully', {
        userId: savedUser._id,
        mobile,
        createdBy
      });

      return savedUser; // Return full document with password and timestamps
    } catch (error) {
      logger.error('Error creating user', {
        error: error.message,
        mobile,
        operatorId: userData.operatorId || currentOperatorId,
        createdBy,
        stack: error.stack
      });
      throw error;
    }
  }

    /**
     * Update user
     * @param {string} id - User ID
     * @param {Object} updateData - Data to update
     * @returns {Promise<Object>} Updated user
     */
  static async updateUser(id, updateData) {
    logger.info('Updating user', { userId: id, updateFields: Object.keys(updateData) });
    
    try {
      const { password, role } = updateData;
      const updateObj = { ...updateData };

      // Hash new password if provided
      if (password) {
        updateObj.password = await bcrypt.hash(password, 10);
        logger.debug('Password hashed for user update', { userId: id });
      }

      // Validate role if being updated
      if (role) {
        const roleExists = await Role.findById(role);
        if (!roleExists) {
          logger.warn('Invalid role ID provided during update', { role });
          throw new Error('Invalid role ID');
        }
      }

      const updatedUser = await User.findByIdAndUpdate(id, updateObj, {
        new: true,
      });

      if (!updatedUser) {
        logger.warn('User not found for update', { userId: id });
        throw new Error('User not found');
      }

      logger.info('User updated successfully', { userId: id });
      return updatedUser;
    } catch (error) {
      logger.error('Error updating user', { 
        error: error.message, 
        userId: id, 
        stack: error.stack 
      });
      throw error;
    }
  }

    /**
     * Delete user
     * @param {string} id - User ID
     * @returns {Promise<Object>} Deletion result
     */
  static async deleteUser(id) {
    logger.info('Deleting user', { userId: id });
    
    try {
      const result = await User.findByIdAndDelete(id);
      if (!result) {
        logger.warn('User not found for deletion', { userId: id });
        throw new Error('User not found');
      }
      logger.info('User deleted successfully', { userId: id });
      return { success: true };
    } catch (error) {
      logger.error('Error deleting user', { 
        error: error.message, 
        userId: id, 
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Search users with pagination
   * @param {Object} options - Search options
   * @param {string} options.query - Search query
   * @param {number} options.page - Page number
   * @param {number} options.limit - Items per page
   * @param {string} options.operatorId - Operator ID
   * @param {string} options.userRole - Current user's role name
   * @returns {Promise<Object>} Search results
   */
  static async searchUsers({ query = "", page = 1, limit = 10, operatorId, operatorIdFromPayload, userRole }) {
    logger.info('Searching users', { query, page, limit, operatorId, operatorIdFromPayload, userRole });
    
    const isSuperUser = userRole === 'SuperUser';
    
    if (!operatorId && !isSuperUser) {
      logger.error('Operator ID is required for user search');
      throw new Error('Operator ID is required');
    }

    try {
      const regex = new RegExp(query, "i");
      const skip = (page - 1) * limit;
      const queryObj = query ? { 
        $or: [
          { fullName: regex },
          { mobile: regex }
        ]
      } : {};
      
      const rawOperatorId = isSuperUser ? operatorIdFromPayload : operatorId;
      const effectiveOperatorId = rawOperatorId
        ? new mongoose.Types.ObjectId(rawOperatorId)
        : null;
      const baseQuery = effectiveOperatorId
        ? { operatorId: effectiveOperatorId, ...queryObj }
        : queryObj;
      
      // Signal to mongooseOperatorScope plugin to preserve this operatorId filter
      const queryOptions = effectiveOperatorId ? { _explicitOperatorId: true } : {};

      const [total, users] = await Promise.all([
        User.countDocuments(baseQuery, queryOptions),
        User.find(baseQuery, null, queryOptions)
          .populate("role")
          .populate("operatorId", "_id name")
          .populate("branchId", "_id name")
          .skip(skip)
          .limit(Number(limit))
      ]);

      logger.debug('User search completed', { 
        total, 
        page, 
        totalPages: Math.ceil(total / limit),
        resultCount: users.length,
        isSuperUser
      });

      return {
        data: users,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      logger.error('Error searching users', { 
        error: error.message, 
        query, 
        operatorId,
        userRole,
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Add amount to user's cargo balance
   * @param {string} userId - User ID
   * @param {number} amount - Amount to add to cargo balance
   * @returns {Promise<Object>} Updated user with new balance
   */
  static async addToCargoBalance(userId, amount) {
    logger.info('Adding amount to cargo balance', { userId, amount });
    
    try {
      const user = await User.findById(userId);
      if (!user) {
        logger.warn('User not found for cargo balance update', { userId });
        throw new Error('User not found');
      }

      const oldBalance = user.cargoBalance || 0;
      const newBalance = oldBalance + amount;
      
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { cargoBalance: newBalance },
        { new: true }
      );

      logger.info('Cargo balance updated successfully', {
        userId,
        amount,
        oldBalance,
        newBalance
      });

      return updatedUser;
    } catch (error) {
      logger.error('Error adding to cargo balance', {
        error: error.message,
        userId,
        amount,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get today's cargo balance for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Cargo balance
   */
  static async getTodayCargoBalance(userId) {
    logger.info('Fetching today\'s cargo balance', { userId });
    
    try {
      const balance = await getDailyCargoBalance(userId);
      const result = {
        date: new Date().toISOString().slice(0, 10),
        balance
      };
      
      logger.debug('Successfully fetched cargo balance', { 
        userId, 
        balance: result.balance,
        date: result.date 
      });
      
      return result;
    } catch (error) {
      logger.error('Error getting cargo balance', { 
        error: error.message, 
        userId,
        stack: error.stack 
      });
      throw new Error('Unable to calculate cargo balance');
    }
  }
}

module.exports = UserService;

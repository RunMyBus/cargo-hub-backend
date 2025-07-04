const express = require('express');
const router = express.Router();
const passport = require('passport');
const userController = require('../controllers/userController');

router.use(passport.authenticate('jwt', { session: false }));

// CRUD routes
router.get('/', userController.getUsers);
router.get('/:id', userController.getUserById);
router.post('/search', userController.searchUsers);
router.post('/', userController.createUser);
router.put('/:id', userController.updateUser);
router.delete('/:id', userController.deleteUser);

module.exports = router;    
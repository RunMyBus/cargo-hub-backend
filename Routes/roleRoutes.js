const express = require('express');
const router = express.Router();
const roleController = require('../controllers/roleController');
const passport = require('passport');
const requireSuperUser = require('../middleware/requireSuperUser');

// Require JWT authentication for all role routes
router.use(passport.authenticate('jwt', { session: false }));
router.get('/', roleController.getRoles);             // Read All
router.get('/search', roleController.searchRoles);   // Search
router.get('/:id', roleController.getRoleById);       // Read One

router.use(requireSuperUser);

router.post('/', roleController.createRole);          // Create
router.put('/:id', roleController.updateRole);        // Update
router.delete('/:id', roleController.deleteRole);     // Delete

module.exports = router;

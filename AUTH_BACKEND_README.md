# QUMAK Backend Authentication System

## Overview

The QUMAK backend implements a complete authentication system using Express.js, MongoDB, and JWT tokens. The system provides secure user registration, login, role-based access control, and integrates with Supabase for file storage.

## Architecture

### Backend Stack
- **Express.js**: Web framework for API endpoints
- **MongoDB**: User data storage with Mongoose ODM
- **JWT**: JSON Web Tokens for authentication
- **bcrypt**: Password hashing and verification
- **Supabase**: File storage and management

### File Structure
```
qumak-backend/
├── controllers/auth/
│   ├── authController.js      # Main authentication logic
│   ├── _routes.js            # Authentication routes
│   └── clerkController.js    # Legacy Clerk integration
├── model/schema/
│   └── user.js               # User data model
├── middelwares/
│   └── auth.js               # JWT verification middleware
├── index.js                  # Main server file
└── test-auth.js              # Authentication testing script
```

## Features

### 🔐 **Authentication Features**
- **User Registration**: Complete signup with role selection
- **User Login**: Secure email/password authentication
- **Password Reset**: Email-based password recovery
- **JWT Tokens**: Secure session management
- **Role-Based Access**: User, Amer Officer, and Admin roles

### 🎯 **User Roles**
- **user**: Regular platform users
- **amer**: Amer officers (government officials)
- **admin**: System administrators

### 🔒 **Security Features**
- **Password Hashing**: bcrypt with salt rounds
- **JWT Verification**: Secure token validation
- **Input Validation**: Request data sanitization
- **Error Handling**: Secure error responses

## API Endpoints

### Public Routes (No Authentication Required)

#### POST `/api/v1/auth/signup`
User registration endpoint.

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "password": "password123",
  "phoneNumber": "+971501234567",
  "country": "AE",
  "role": "user"
}
```

**Amer Officer Registration:**
```json
{
  "firstName": "Amer",
  "lastName": "Officer",
  "email": "amer@example.com",
  "password": "password123",
  "phoneNumber": "+971501234567",
  "country": "AE",
  "role": "amer",
  "emiratesId": "123456789",
  "company": "Government Department"
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "user_id",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "role": "user"
    },
    "token": "jwt_token_here"
  }
}
```

#### POST `/api/v1/auth/signin`
User login endpoint.

**Request Body:**
```json
{
  "email": "john@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "user_id",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "role": "user",
      "lastLogin": "2025-01-31T18:40:00.000Z"
    },
    "token": "jwt_token_here"
  }
}
```

#### POST `/api/v1/auth/forgot-password`
Password reset request endpoint.

**Request Body:**
```json
{
  "email": "john@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password reset link sent to your email"
}
```

#### POST `/api/v1/auth/reset-password`
Password reset confirmation endpoint.

**Request Body:**
```json
{
  "token": "reset_token_here",
  "newPassword": "newpassword123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

### Protected Routes (Authentication Required)

All protected routes require the `Authorization: Bearer <token>` header.

#### GET `/api/v1/auth/profile`
Get current user profile.

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user_id",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "role": "user",
      "phoneNumber": "+971501234567",
      "country": "AE",
      "lastLogin": "2025-01-31T18:40:00.000Z",
      "createdAt": "2025-01-31T18:40:00.000Z",
      "updatedAt": "2025-01-31T18:40:00.000Z"
    }
  }
}
```

#### PUT `/api/v1/auth/profile`
Update user profile.

**Request Body:**
```json
{
  "firstName": "John Updated",
  "phoneNumber": "+971501234568"
}
```

#### POST `/api/v1/auth/change-password`
Change user password.

**Request Body:**
```json
{
  "currentPassword": "oldpassword123",
  "newPassword": "newpassword123"
}
```

#### POST `/api/v1/auth/upload-file`
Upload file to Supabase and save reference to MongoDB.

**Request Body:**
```json
{
  "file": "file_buffer",
  "fileType": "passport",
  "remarks": "Passport copy"
}
```

#### GET `/api/v1/auth/documents`
Get user documents.

**Response:**
```json
{
  "success": true,
  "data": {
    "documents": [
      {
        "type": "passport",
        "path": "https://supabase-url.com/file.pdf",
        "remarks": "Passport copy",
        "uploadDate": "2025-01-31T18:40:00.000Z"
      }
    ]
  }
}
```

#### POST `/api/v1/auth/logout`
User logout endpoint.

## Database Schema

### User Model
```javascript
const userSchema = new mongoose.Schema({
  // Basic Information
  firstName: { type: String, required: true },
  lastName: { type: String },
  email: { type: String, required: true, unique: true },
  phoneNumber: String,
  password: { type: String, required: true, minlength: 6 },
  
  // Role & Access
  role: { type: String, enum: ['admin', 'user', 'manager', 'sponsor', 'sponsored', 'amer'], default: 'user' },
  lastLogin: Date,
  deleted: { type: Boolean, default: false },
  
  // Password Reset
  resetToken: String,
  resetTokenExpires: Date,
  
  // Amer Officer Fields
  emiratesId: String,
  passportNumber: String,
  company: String,
  country: String,
  
  // Documents
  profilePicture: fileRefSchema,
  documents: [documentSchema],
  
  // Entry Tracking
  entries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceEntryData' }],
  entryCount: { type: Number, default: 0 },
  lastEntryDate: Date
}, {
  timestamps: true
});
```

## Setup Instructions

### 1. Environment Variables
Create a `.env` file in the backend root:

```bash
# Database Configuration
DB_URL=mongodb://127.0.0.1:27017
DB=qumak

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-in-production

# Supabase Configuration (for file storage)
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key

# Server Configuration
PORT=5001
NODE_ENV=development
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Start MongoDB
Ensure MongoDB is running on your system.

### 4. Start the Server
```bash
npm run dev
```

### 5. Test the System
```bash
node test-auth.js
```

## Testing

### Manual Testing
Use the provided `test-auth.js` script to test all endpoints:

```bash
node test-auth.js
```

### API Testing Tools
- **Postman**: Import the endpoints and test manually
- **Insomnia**: Alternative to Postman
- **curl**: Command-line testing

### Example curl Commands
```bash
# User Registration
curl -X POST http://localhost:5001/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"User","email":"test@example.com","password":"password123"}'

# User Login
curl -X POST http://localhost:5001/api/v1/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Get Profile (with token)
curl -X GET http://localhost:5001/api/v1/auth/profile \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Security Features

### JWT Implementation
- **Secret Key**: Configurable via environment variable
- **Expiration**: 7 days for regular tokens, 1 hour for reset tokens
- **Payload**: User ID, email, and role information

### Password Security
- **Hashing**: bcrypt with 10 salt rounds
- **Validation**: Minimum 6 characters required
- **Reset**: Secure token-based password reset

### Input Validation
- **Required Fields**: firstName, lastName, email, password
- **Email Format**: Valid email address validation
- **Role Validation**: Enum-based role checking

### Error Handling
- **Generic Messages**: Don't reveal system information
- **Status Codes**: Proper HTTP status codes
- **Logging**: Server-side error logging

## Integration with Frontend

### Frontend Configuration
The frontend should be configured with:

```bash
VITE_API_URL=http://localhost:5001/api/v1
```

### Authentication Flow
1. **Registration**: User signs up → Backend creates user → Returns JWT token
2. **Login**: User signs in → Backend validates → Returns JWT token
3. **Protected Routes**: Frontend includes token in Authorization header
4. **Token Refresh**: Frontend handles token expiration

### File Upload Flow
1. **Frontend**: Sends file to backend endpoint
2. **Backend**: Uploads to Supabase storage
3. **Backend**: Saves file reference to MongoDB
4. **Response**: Returns file URL and metadata

## Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "success": false,
  "message": "Missing required fields"
}
```

#### 401 Unauthorized
```json
{
  "success": false,
  "message": "Authentication failed, Token missing"
}
```

#### 403 Forbidden
```json
{
  "success": false,
  "message": "Forbidden: insufficient role"
}
```

#### 404 Not Found
```json
{
  "success": false,
  "message": "User not found"
}
```

#### 500 Internal Server Error
```json
{
  "success": false,
  "message": "Internal server error",
  "error": "Error details"
}
```

## Performance Optimization

### Database Indexes
- Email field (unique)
- Role field
- Deleted field

### Caching Strategies
- JWT token validation caching
- User profile caching
- Document list caching

### Rate Limiting
Consider implementing rate limiting for:
- Login attempts
- Password reset requests
- File uploads

## Monitoring and Logging

### Logging
- Authentication attempts
- Password reset requests
- File upload operations
- Error occurrences

### Metrics
- User registration rate
- Login success/failure rate
- API endpoint usage
- Response times

## Production Deployment

### Security Checklist
- [ ] Change default JWT secret
- [ ] Enable HTTPS
- [ ] Set up proper CORS
- [ ] Implement rate limiting
- [ ] Set up monitoring
- [ ] Configure logging
- [ ] Set up backup strategy

### Environment Variables
- [ ] Production database URL
- [ ] Strong JWT secret
- [ ] Supabase production credentials
- [ ] Logging configuration
- [ ] Monitoring endpoints

## Troubleshooting

### Common Issues

#### "Database Not connected"
- Check MongoDB service status
- Verify connection string
- Check network connectivity

#### "JWT verification failed"
- Verify JWT_SECRET environment variable
- Check token expiration
- Validate token format

#### "User not found"
- Check user deletion status
- Verify user ID format
- Check database connection

#### "File upload failed"
- Verify Supabase credentials
- Check storage bucket permissions
- Validate file size and type

### Debug Mode
Enable debug logging by setting:
```bash
NODE_ENV=development
```

## Support

### Documentation
- [Express.js Documentation](https://expressjs.com/)
- [MongoDB Documentation](https://docs.mongodb.com/)
- [JWT Documentation](https://jwt.io/)
- [Supabase Documentation](https://supabase.com/docs)

### Community
- Express.js community forums
- MongoDB community
- JWT implementation guides
- Supabase community

---

**Last Updated**: January 2025  
**Version**: 1.0.0  
**Maintainer**: qumak Development Team

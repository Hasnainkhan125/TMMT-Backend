# Qumak Backend Authentication - Quick Setup Guide

## 🚀 Quick Start (3 minutes)

### 1. Environment Setup
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

## 🔧 What's Been Created

### New Files
- **`controllers/auth/authController.js`** - Complete authentication logic
- **`controllers/auth/_routes.js`** - Updated with new auth endpoints
- **`model/schema/user.js`** - Enhanced user schema with reset tokens
- **`middelwares/auth.js`** - Fixed JWT verification
- **`test-auth.js`** - Testing script for all endpoints

### Updated Files
- **`index.js`** - Already had auth routes configured
- **`package.json`** - Added Supabase and axios dependencies

## 📡 API Endpoints Available

### Public Routes
- `POST /api/v1/auth/signup` - User registration
- `POST /api/v1/auth/signin` - User login
- `POST /api/v1/auth/forgot-password` - Password reset request
- `POST /api/v1/auth/reset-password` - Password reset confirmation

### Protected Routes
- `GET /api/v1/auth/profile` - Get user profile
- `PUT /api/v1/auth/profile` - Update user profile
- `POST /api/v1/auth/change-password` - Change password
- `POST /api/v1/auth/upload-file` - Upload file to Supabase
- `GET /api/v1/auth/documents` - Get user documents
- `POST /api/v1/auth/logout` - User logout

## 🧪 Testing

### Run the Test Script
```bash
node test-auth.js
```

This will test:
- User registration
- Amer officer registration
- User login
- Protected route access
- Profile retrieval
- Password reset

### Manual Testing with curl
```bash
# Register a user
curl -X POST http://localhost:5001/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"User","email":"test@example.com","password":"password123"}'

# Login
curl -X POST http://localhost:5001/api/v1/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

## 🔐 User Roles

### Available Roles
- **`user`** - Regular platform users
- **`amer`** - Amer officers (requires Emirates ID)
- **`admin`** - System administrators

### Role-Specific Fields
- **Amer Officers**: `emiratesId`, `passportNumber`, `company`
- **All Users**: `firstName`, `lastName`, `email`, `password`, `phoneNumber`, `country`

## 📁 File Storage

### Supabase Integration
- Files are uploaded to Supabase storage
- File references are saved in MongoDB
- Public URLs are generated for access
- Supports all common file types

### File Upload Flow
1. Frontend sends file to `/api/v1/auth/upload-file`
2. Backend uploads to Supabase storage
3. File reference saved to MongoDB
4. Public URL returned to frontend

## 🚨 Troubleshooting

### Common Issues

**"Database Not connected"**
- Check if MongoDB is running
- Verify connection string in `.env`

**"JWT verification failed"**
- Check `JWT_SECRET` in `.env`
- Ensure token format is correct

**"User not found"**
- Check if user exists in database
- Verify user deletion status

**"File upload failed"**
- Check Supabase credentials
- Verify storage bucket permissions

### Debug Mode
Set `NODE_ENV=development` in your `.env` file for detailed logging.

## 🔗 Frontend Integration

### Frontend Configuration
Your frontend should have:

```bash
VITE_API_URL=http://localhost:5001/api/v1
```

### Authentication Flow
1. User registers/logs in → Backend returns JWT token
2. Frontend stores token in localStorage
3. Frontend includes token in Authorization header
4. Backend validates token and processes requests

### Example Frontend Request
```typescript
const response = await fetch(`${API_BASE_URL}/auth/profile`, {
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
    'Content-Type': 'application/json',
  },
});
```

## 📚 Next Steps

### Immediate
1. **Test the system** with `node test-auth.js`
2. **Start your frontend** and navigate to `/auth`
3. **Try registering** with different roles

### Future Enhancements
1. **Email Integration** - Send password reset emails
2. **Rate Limiting** - Prevent abuse
3. **Audit Logging** - Track authentication events
4. **Two-Factor Authentication** - Additional security
5. **Social Login** - Google, Facebook, etc.

## 📞 Support

- **Backend Documentation**: `AUTH_BACKEND_README.md`
- **Frontend Documentation**: Check frontend folder
- **Testing**: Use `test-auth.js` script
- **Issues**: Check console logs and error responses

---

**Setup Time**: ~3 minutes  
**Difficulty**: Beginner  
**Last Updated**: January 2025

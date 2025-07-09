# Connector Integration PR Dashboard

A real-time dashboard for monitoring connector integration pull requests in the HyperSwitch project. This dashboard provides engineering managers with comprehensive oversight of PR review processes, bottleneck identification, and analytics.

## Features

- **Real-time Updates**: WebSocket-powered live updates as GitHub events occur
- **PR Overview**: Visual cards showing PR status, approvals, and review progress
- **Advanced Filtering**: Filter by status, review needs, and changes requested
- **Analytics Dashboard**: Charts and metrics for process optimization
- **GitHub Integration**: Direct integration with GitHub API and webhooks
- **Responsive Design**: Modern UI built with React and Tailwind CSS

## Tech Stack

### Frontend
- React 18 with TypeScript
- Tailwind CSS for styling
- React Query for data management
- Recharts for data visualization
- Heroicons for icons
- WebSocket for real-time updates

### Backend
- Node.js with TypeScript
- Express.js for API endpoints
- GitHub REST API integration
- WebSocket server for real-time communication
- In-memory storage (can be extended to PostgreSQL)

## Prerequisites

- Node.js 16+ and npm
- GitHub Personal Access Token
- Access to the HyperSwitch repository (or modify for your repository)

## Setup Instructions

### 1. Clone and Install Dependencies

```bash
# Navigate to the project directory
cd connector-pr-dashboard

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2. Backend Configuration

```bash
# In the backend directory
cd backend

# Copy environment template
cp .env.example .env

# Edit .env file with your GitHub token
# GITHUB_TOKEN=your_github_personal_access_token_here
```

#### Creating a GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with the following scopes:
   - `repo` (for private repositories) or `public_repo` (for public repositories)
   - `read:org` (if accessing organization repositories)
3. Copy the token and add it to your `.env` file

### 3. Start the Application

#### Terminal 1 - Backend Server
```bash
cd backend
npm run dev
```
The backend will start on `http://localhost:3001`

#### Terminal 2 - Frontend Development Server
```bash
cd frontend
npm start
```
The frontend will start on `http://localhost:3000`

### 4. Access the Dashboard

Open your browser and navigate to `http://localhost:3000`

## Configuration

### Repository Settings

By default, the dashboard monitors the `juspay/hyperswitch` repository. To change this:

1. Edit `backend/src/index.ts`
2. Update the `owner` and `repo` values in the GitHub API calls
3. Restart the backend server

### PR Identification

The dashboard identifies connector integration PRs by the label `A-connector-integration`. To change this:

1. Edit the `isConnectorIntegrationPR` function in `backend/src/index.ts`
2. Modify the label name or add additional criteria
3. Restart the backend server

## API Endpoints

- `GET /api/prs` - Get all connector integration PRs
- `GET /api/prs/:prNumber/reviews` - Get reviews for a specific PR
- `GET /api/prs/:prNumber/comments` - Get comments for a specific PR
- `GET /api/analytics` - Get dashboard analytics
- `POST /api/webhook` - GitHub webhook endpoint (for production)

## WebSocket Events

- `prs_updated` - Sent when PR data is refreshed
- `initial_data` - Sent to new clients with current data

## Development

### Adding New Features

1. **Frontend Components**: Add new components in `frontend/src/components/`
2. **Backend Routes**: Add new API routes in `backend/src/index.ts`
3. **Types**: Update TypeScript interfaces as needed

### Database Integration

To replace in-memory storage with PostgreSQL:

1. Install PostgreSQL dependencies: `npm install pg @types/pg`
2. Create database schema (see `database/schema.sql`)
3. Replace in-memory arrays with database queries
4. Add database connection configuration

## Production Deployment

### Backend Deployment

1. Build the TypeScript code: `npm run build`
2. Set environment variables on your hosting platform
3. Deploy the `dist` folder and `package.json`
4. Set up GitHub webhooks pointing to your `/api/webhook` endpoint

### Frontend Deployment

1. Set `REACT_APP_API_URL` environment variable to your backend URL
2. Build the React app: `npm run build`
3. Deploy the `build` folder to a static hosting service

### Recommended Platforms

- **Backend**: Railway, Render, Heroku, or AWS/GCP/Azure
- **Frontend**: Vercel, Netlify, or any static hosting service

## GitHub Webhooks (Production)

For real-time updates in production, set up GitHub webhooks:

1. Go to your repository Settings → Webhooks
2. Add a new webhook with:
   - Payload URL: `https://your-backend-url.com/api/webhook`
   - Content type: `application/json`
   - Events: Pull requests, Pull request reviews, Issue comments
3. Ensure webhook signature verification is implemented for security

## Troubleshooting

### Common Issues

1. **GitHub API Rate Limits**: Ensure you're using a personal access token
2. **WebSocket Connection Failed**: Check if backend is running on port 3001
3. **No PRs Showing**: Verify the repository name and label configuration
4. **CORS Errors**: Ensure backend CORS is configured for your frontend URL

### Logs

- Backend logs: Check the terminal running `npm run dev`
- Frontend logs: Check browser developer console
- GitHub API errors: Look for 401/403 status codes indicating token issues

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.

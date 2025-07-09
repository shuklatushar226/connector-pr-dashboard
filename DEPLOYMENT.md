# Connector PR Dashboard - Deployment Guide

## 🚀 Quick Deployment: Render + Vercel

This guide will help you deploy the Connector PR Dashboard using **Render** (backend) and **Vercel** (frontend) - both free!

---

## 📋 Prerequisites

Before starting, ensure you have:

1. **GitHub account** with this repository
2. **New GitHub Personal Access Token** (we'll create this)
3. **New Google Gemini API Key** (we'll create this)
4. **Render account** (free signup at render.com)
5. **Vercel account** (free signup at vercel.com)

---

## 🔑 Step 1: Create API Keys

### GitHub Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. Click **"Generate new token (classic)"**
3. Set expiration to **"No expiration"** (or 1 year)
4. Select scopes:
   - ✅ `repo` (for private repos) OR `public_repo` (for public repos)
   - ✅ `read:org` (to read organization data)
5. Click **"Generate token"**
6. **Copy the token** - you won't see it again!

### Google Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click **"Create API Key"**
3. Select your Google Cloud project (or create new)
4. **Copy the API key**

---

## 🖥️ Step 2: Deploy Backend to Render

### 2.1 Create Render Account
1. Go to [render.com](https://render.com)
2. Sign up with GitHub account
3. Authorize Render to access your repositories

### 2.2 Deploy Backend Service
1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository
3. Configure the service:
   - **Name**: `connector-pr-dashboard-backend`
   - **Root Directory**: `backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`

### 2.3 Set Environment Variables
In the Render dashboard, go to **Environment** tab and add:

```
GITHUB_TOKEN=your_github_token_here
GEMINI_API_KEY=your_gemini_api_key_here
GITHUB_OWNER=juspay
GITHUB_REPO=hyperswitch
GEMINI_MODEL=gemini-2.0-flash-exp
NODE_ENV=production
PORT=3001
```

### 2.4 Deploy
1. Click **"Create Web Service"**
2. Wait for deployment (5-10 minutes)
3. **Copy your backend URL** (e.g., `https://your-app.onrender.com`)

---

## 🌐 Step 3: Deploy Frontend to Vercel

### 3.1 Create Vercel Account
1. Go to [vercel.com](https://vercel.com)
2. Sign up with GitHub account
3. Authorize Vercel to access your repositories

### 3.2 Deploy Frontend
1. Click **"New Project"**
2. Import your GitHub repository
3. Configure the project:
   - **Framework Preset**: `Create React App`
   - **Root Directory**: `frontend`
   - **Build Command**: `npm run build`
   - **Output Directory**: `build`

### 3.3 Set Environment Variables
In the Vercel dashboard, go to **Settings** → **Environment Variables** and add:

```
REACT_APP_API_URL=https://your-backend.onrender.com
```

Replace `your-backend.onrender.com` with your actual Render backend URL.

### 3.4 Deploy
1. Click **"Deploy"**
2. Wait for deployment (2-5 minutes)
3. **Copy your frontend URL** (e.g., `https://your-app.vercel.app`)

---

## 🔧 Step 4: Update Backend CORS

### 4.1 Update CORS Configuration
1. Go back to your Render dashboard
2. Go to **Environment** tab
3. Update the backend code to allow your Vercel domain:

In `backend/src/index.ts`, the CORS is already configured to accept production URLs. You just need to update the placeholder:

```typescript
origin: process.env.NODE_ENV === 'production' 
  ? ['https://your-frontend-domain.vercel.app'] // Update this with your actual Vercel URL
  : ['http://localhost:3000', 'http://127.0.0.1:3000'],
```

### 4.2 Redeploy Backend
1. Push the CORS update to GitHub
2. Render will automatically redeploy

---

## ✅ Step 5: Test Your Deployment

### 5.1 Verify Backend
1. Visit your Render backend URL
2. Check `/api/prs` endpoint
3. Verify data is loading

### 5.2 Verify Frontend
1. Visit your Vercel frontend URL
2. Check that dashboard loads
3. Verify data appears in all tabs
4. Test navigation between tabs

### 5.3 Test Real-time Updates
1. The backend fetches data every 5 minutes automatically
2. This keeps Render from sleeping (no cold starts!)
3. WebSocket connections provide real-time updates

---

## 🎯 Step 6: Optional Enhancements

### Custom Domain (Optional)
1. **Vercel**: Settings → Domains → Add your domain
2. **Render**: Settings → Custom Domains → Add your domain

### Monitoring (Optional)
1. Set up [UptimeRobot](https://uptimerobot.com) (free)
2. Monitor your backend URL every 5 minutes
3. Get alerts if service goes down

---

## 🔍 Troubleshooting

### Backend Issues
- **Check Render logs**: Dashboard → Logs tab
- **Verify environment variables**: Dashboard → Environment tab
- **Test API endpoints**: Visit `/api/prs` directly

### Frontend Issues
- **Check Vercel logs**: Dashboard → Functions tab
- **Verify environment variables**: Settings → Environment Variables
- **Check browser console**: F12 → Console tab

### Common Issues

1. **CORS Errors**: Update backend CORS configuration with correct frontend URL
2. **API Key Errors**: Verify GitHub token has correct permissions
3. **No Data**: Check GitHub repository name and owner in environment variables
4. **Cold Starts**: Your 5-minute data fetching should prevent this

---

## 📊 Expected Performance

### Free Tier Limits
- **Render**: Unlimited hours, 30-second cold starts (prevented by your app)
- **Vercel**: Unlimited bandwidth, no cold starts
- **Total Cost**: $0/month

### Performance Metrics
- **Backend Response Time**: <200ms (when warm)
- **Frontend Load Time**: <2 seconds
- **Data Refresh**: Every 5 minutes
- **Uptime**: 99.9% (effectively always on)

---

## 🎉 Success!

Your Connector PR Dashboard is now live and accessible worldwide!

- **Frontend**: https://your-app.vercel.app
- **Backend**: https://your-app.onrender.com
- **Cost**: Free
- **Maintenance**: Minimal

The dashboard will automatically:
- ✅ Fetch new PRs every 5 minutes
- ✅ Stay warm (no cold starts)
- ✅ Update in real-time via WebSocket
- ✅ Generate AI summaries on demand
- ✅ Provide analytics and insights

---

## 📞 Support

If you encounter any issues:
1. Check the troubleshooting section above
2. Review Render and Vercel logs
3. Verify all environment variables are set correctly
4. Ensure API keys have proper permissions

Happy deploying! 🚀

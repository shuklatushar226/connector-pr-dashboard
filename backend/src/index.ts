import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import WebSocket from 'ws';
import http from 'http';
import geminiService, { PRSummary, CommonLearning, CommentCategorizationResponse } from './services/geminiService';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Security and middleware configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://frontend-plum-eta-85.vercel.app'] // Your actual Vercel frontend URL
    : true, // Allow all origins in development (including macOS app)
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Rate limiting for API endpoints
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 1000000; // requests per hour (increased for development)
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

app.use('/api', (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  const clientData = requestCounts.get(clientIP);
  
  if (!clientData || now > clientData.resetTime) {
    requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_WINDOW });
    next();
  } else if (clientData.count < RATE_LIMIT) {
    clientData.count++;
    next();
  } else {
    res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }
});

// GitHub API client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Types
interface PullRequest {
  id: number;
  github_pr_number: number;
  title: string;
  author: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  status: 'open' | 'merged' | 'closed';
  is_connector_integration: boolean;
  current_approvals_count: number;
  labels: string[];
  reviewers: string[];
  requested_reviewers: string[];
  pending_reviewers: string[];
  url: string;
}

interface Review {
  id: number;
  pr_id: number;
  reviewer_username: string;
  review_state: 'commented' | 'approved' | 'changes_requested';
  submitted_at: string;
  is_latest_review: boolean;
  content?: string; // Add content field for review text
}

interface CodeContext {
  file_path: string;
  line_number: number;
  code_snippet: string;
  context_range: string;
  language: string;
}

interface Comment {
  id: number;
  pr_id: number;
  github_comment_id: number;
  author: string;
  content: string;
  created_at: string;
  is_resolved: boolean;
  comment_type: 'review' | 'issue' | 'general';
  // Code context fields for review comments
  file_path?: string | null;
  line_number?: number | null;
  diff_hunk?: string | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  // Enhanced code context
  code_context?: CodeContext | null;
}

// Timeline interfaces
interface PRTimelineStage {
  stage: 'pr_raised' | 'first_review' | 'comments_fixed' | 'approved' | 'merged';
  timestamp: string;
  duration_from_previous?: number; // in hours
}

interface PRTimeline {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  total_duration: number; // total time from raise to merge in hours
  stages: PRTimelineStage[];
  is_completed: boolean; // whether PR reached merged stage
  stage_durations: {
    pr_raised_to_first_review: number;
    first_review_to_comments_fixed: number;
    comments_fixed_to_approved: number;
    approved_to_merged: number;
    ongoing_time: number; // Time for open PRs from last activity to now
    total_review_time: number;
  };
  milestones: {
    pr_created: { timestamp: string; achieved: boolean; };
    first_review: { timestamp: string | null; achieved: boolean; };
    approved: { timestamp: string | null; achieved: boolean; };
    merged: { timestamp: string | null; achieved: boolean; };
  };
}

// In-memory storage (replace with database in production)
let pullRequests: PullRequest[] = [];
let reviews: Review[] = [];
let comments: Comment[] = [];
let prSummaries: Map<number, PRSummary> = new Map(); // Store AI summaries by PR number
let commonLearning: CommonLearning | null = null; // Store common learning insights

// Comment categorization cache
interface CachedCommentCategorization {
  data: CommentCategorizationResponse;
  generated_at: string;
  expires_at: string;
  version: string; // Based on data hash to detect changes
}
let commentCategorizationCache: CachedCommentCategorization | null = null;

// Cache management constants
const CACHE_EXPIRY_HOURS = 2; // Cache expires after 2 hours
const CACHE_VERSION_PREFIX = 'v1_';

// Helper function to generate data version hash
function generateDataVersionHash(): string {
  const dataString = JSON.stringify({
    prCount: pullRequests.length,
    commentCount: comments.length,
    lastUpdated: pullRequests.map(pr => pr.updated_at).sort().slice(-1)[0] || '',
    humanCommentCount: comments.filter(isHumanComment).length
  });
  
  // Simple hash function for cache versioning
  let hash = 0;
  for (let i = 0; i < dataString.length; i++) {
    const char = dataString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return CACHE_VERSION_PREFIX + Math.abs(hash).toString(36);
}

// Helper function to check if cache is valid
function isCacheValid(cache: CachedCommentCategorization | null): boolean {
  if (!cache) {
    return false;
  }
  
  const now = new Date();
  const expiryTime = new Date(cache.expires_at);
  const currentVersion = generateDataVersionHash();
  
  const isNotExpired = now < expiryTime;
  const isVersionValid = cache.version === currentVersion;
  
  console.log(`🔍 Cache validation:`);
  console.log(`   ⏰ Not expired: ${isNotExpired} (expires: ${cache.expires_at})`);
  console.log(`   🏷️  Version valid: ${isVersionValid} (cache: ${cache.version}, current: ${currentVersion})`);
  
  return isNotExpired && isVersionValid;
}

// Helper function to create cache entry
function createCacheEntry(data: CommentCategorizationResponse): CachedCommentCategorization {
  const now = new Date();
  const expiryTime = new Date(now.getTime() + (CACHE_EXPIRY_HOURS * 60 * 60 * 1000));
  
  return {
    data,
    generated_at: now.toISOString(),
    expires_at: expiryTime.toISOString(),
    version: generateDataVersionHash()
  };
}

// Background categorization generation
async function generateBackgroundCategorization() {
  try {
    console.log('🔄 Starting background comment categorization...');
    
    // Check if there's enough data to analyze
    if (pullRequests.length === 0) {
      console.log('⏭️ Skipping background categorization - no PR data available');
      return;
    }

    // Filter out bot comments for better analysis
    const humanComments = comments.filter(isHumanComment);
    
    if (humanComments.length === 0) {
      console.log('⏭️ Skipping background categorization - no human comments available');
      return;
    }

    console.log(`🤖 Background categorizing ${humanComments.length} human comments from ${pullRequests.length} PRs...`);

    // Generate comment categorization using Gemini
    const categorization = await geminiService.categorizeComments(pullRequests, humanComments);
    
    // Create and store cache entry
    commentCategorizationCache = createCacheEntry(categorization);
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'categorization_generated', 
      data: categorization 
    });
    
    console.log(`✅ Background comment categorization completed successfully`);
    console.log(`📈 Cached results: ${categorization.overall_summary.total_comments_categorized} comments categorized`);

  } catch (error) {
    console.error('❌ Error in background comment categorization:', error);
  }
}

// Helper function to check if PR is connector integration
function isConnectorIntegrationPR(pr: any): boolean {
  return pr.labels.some((label: any) => label.name === 'A-connector-integration');
}

// Bot detection patterns
const BOT_PATTERNS = [
  // Explicit bot indicators
  /\[bot\]$/i,
  /bot$/i,
  /-bot$/i,
  
  // Known bot services (case-insensitive)
  'semanticdiff-com[bot]',
  'coderabbitai[bot]',
  'dependabot[bot]',
  'github-actions[bot]',
  'renovate[bot]',
  'codecov[bot]',
  'sonarcloud[bot]',
  'snyk-bot',
  'whitesource-bolt[bot]',
  'deepsource-autofix[bot]',
  'gitguardian[bot]',
  
  // CI/CD bots
  'circleci-bot',
  'travis-ci',
  'jenkins-bot',
  'azure-pipelines[bot]',
  
  // Security/Quality bots
  'lgtm-com[bot]',
  'codeclimate[bot]',
  'houndci-bot',
  'vercel[bot]',
  'netlify[bot]',
  'heroku[bot]'
];

// Automated content patterns
const AUTOMATED_CONTENT_PATTERNS = [
  /^Review changes with\s+SemanticDiff/i,
  /^Changed Files/i,
  /^Coverage report/i,
  /^Build Status:/i,
  /^Deploy Preview/i,
  /^This pull request/i,
  /^Automated merge/i,
  /^\*\*Summary\*\* by CodeRabbit/i,
  /^## Summary by Coderabbit/i,
  /^## Summary by CodeRabbit/i,
  /^🤖 This is an automated/i,
  /^Dependency update/i,
  /^Security update/i,
  /^Auto-generated/i,
  /^Automatically generated/i
];

// Helper function to detect if a comment is from a human
function isHumanComment(comment: Comment): boolean {
  // Check if author is a bot
  const isBotUser = BOT_PATTERNS.some(pattern => {
    if (typeof pattern === 'string') {
      return comment.author.toLowerCase() === pattern.toLowerCase();
    }
    return pattern.test(comment.author);
  });
  
  if (isBotUser) {
    console.log(`🤖 Filtered bot comment from: ${comment.author}`);
    return false;
  }
  
  // Check if content is automated
  const isAutomatedContent = AUTOMATED_CONTENT_PATTERNS.some(pattern => 
    pattern.test(comment.content.trim())
  );
  
  if (isAutomatedContent) {
    console.log(`🤖 Filtered automated content from: ${comment.author}`);
    return false;
  }
  
  // Additional checks
  if (comment.content.length < 10) {
    console.log(`🤖 Filtered short comment from: ${comment.author} (${comment.content.length} chars)`);
    return false;
  }
  
  // Status emoji patterns (likely automated)
  if (/^(✅|❌|🔄|⚠️|🚀|📦|🔧)\s/.test(comment.content)) {
    console.log(`🤖 Filtered status emoji comment from: ${comment.author}`);
    return false;
  }
  
  return true;
}

// Helper function to detect if a review is from a human
function isHumanReview(review: Review): boolean {
  return isHumanComment({
    author: review.reviewer_username,
    content: review.content || '',
    // Add other required Comment fields with defaults
    id: review.id,
    pr_id: review.pr_id,
    github_comment_id: review.id,
    created_at: review.submitted_at,
    is_resolved: false,
    comment_type: 'review'
  });
}

// Analysis strategy determination
interface PRAnalysisStrategy {
  type: 'human_discussion' | 'code_only' | 'hybrid';
  human_comments: number;
  bot_comments: number;
  human_reviews: number;
  bot_reviews: number;
  confidence_level: 'high' | 'medium' | 'low';
}

function determineAnalysisStrategy(comments: Comment[], reviews: Review[]): PRAnalysisStrategy {
  const humanComments = comments.filter(isHumanComment);
  const botComments = comments.filter(c => !isHumanComment(c));
  const humanReviews = reviews.filter(isHumanReview);
  const botReviews = reviews.filter(r => !isHumanReview(r));
  
  const totalHumanInteractions = humanComments.length + humanReviews.length;
  
  if (totalHumanInteractions === 0) {
    return {
      type: 'code_only',
      human_comments: humanComments.length,
      bot_comments: botComments.length,
      human_reviews: humanReviews.length,
      bot_reviews: botReviews.length,
      confidence_level: 'medium'
    };
  } else if (totalHumanInteractions >= 5 || humanReviews.length >= 2) {
    return {
      type: 'human_discussion',
      human_comments: humanComments.length,
      bot_comments: botComments.length,
      human_reviews: humanReviews.length,
      bot_reviews: botReviews.length,
      confidence_level: 'high'
    };
  } else {
    return {
      type: 'hybrid',
      human_comments: humanComments.length,
      bot_comments: botComments.length,
      human_reviews: humanReviews.length,
      bot_reviews: botReviews.length,
      confidence_level: 'medium'
    };
  }
}

// Helper function to normalize GitHub review states
function normalizeReviewState(githubState: string): 'commented' | 'approved' | 'changes_requested' {
  switch (githubState.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
      return 'commented'; // Treat dismissed as commented
    default:
      console.log(`⚠️ Unknown review state: ${githubState}, treating as commented`);
      return 'commented';
  }
}

// Helper function to count approvals
function countApprovals(prNumber: number): number {
  const prReviews = reviews.filter(r => r.pr_id === prNumber && r.is_latest_review);
  const approvedReviews = prReviews.filter(r => r.review_state === 'approved');
  
  console.log(`📊 PR #${prNumber}: ${approvedReviews.length} approvals out of ${prReviews.length} total reviews`);
  if (approvedReviews.length > 0) {
    console.log(`   ✅ Approved by: ${approvedReviews.map(r => r.reviewer_username).join(', ')}`);
  }
  
  return approvedReviews.length;
}

// Helper function to calculate days difference between two dates
function calculateDaysDiff(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24) * 10) / 10; // Round to 1 decimal place
}

// Enhanced timeline interfaces with validation
interface PRTimelineValidation {
  is_valid: boolean;
  confidence_score: number;
  issues: string[];
  data_quality: 'high' | 'medium' | 'low';
}

interface EnhancedPRTimeline extends PRTimeline {
  validation: PRTimelineValidation;
  review_cycles: ReviewCycle[];
  actual_events: TimelineEvent[];
}

interface ReviewCycle {
  cycle_number: number;
  changes_requested_at: string;
  changes_addressed_at: string | null;
  duration_days: number;
  reviewer: string;
}

interface TimelineEvent {
  event_type: 'pr_created' | 'first_review' | 'changes_requested' | 'changes_addressed' | 'approved' | 'merged';
  timestamp: string;
  actor: string;
  details?: string;
}

// Helper function to calculate PR timeline with improved accuracy
function calculatePRTimeline(pr: PullRequest, prReviews: Review[], prComments: Comment[]): PRTimeline {
  // Use the enhanced calculation but return the basic interface for backward compatibility
  const enhancedTimeline = calculateEnhancedPRTimeline(pr, prReviews, prComments);
  
  // Convert to basic timeline format
  return {
    pr_number: enhancedTimeline.pr_number,
    pr_title: enhancedTimeline.pr_title,
    pr_author: enhancedTimeline.pr_author,
    total_duration: enhancedTimeline.total_duration,
    stages: enhancedTimeline.stages,
    is_completed: enhancedTimeline.is_completed,
    stage_durations: enhancedTimeline.stage_durations,
    milestones: enhancedTimeline.milestones
  };
}

// Enhanced timeline calculation with proper event-driven logic
function calculateEnhancedPRTimeline(pr: PullRequest, prReviews: Review[], prComments: Comment[]): EnhancedPRTimeline {
  const stages: PRTimelineStage[] = [];
  const stageDurations = {
    pr_raised_to_first_review: 0,
    first_review_to_comments_fixed: 0,
    comments_fixed_to_approved: 0,
    approved_to_merged: 0,
    ongoing_time: 0,
    total_review_time: 0
  };

  // Create chronological event timeline
  const events: TimelineEvent[] = [];
  const issues: string[] = [];
  let confidenceScore = 1.0;

  // PR Creation Event
  events.push({
    event_type: 'pr_created',
    timestamp: pr.created_at,
    actor: pr.author
  });

  stages.push({
    stage: 'pr_raised',
    timestamp: pr.created_at
  });

  // Process all reviews chronologically
  const sortedReviews = prReviews.sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());
  const reviewCycles: ReviewCycle[] = [];
  
  let firstReviewFound = false;
  let currentCycle = 0;
  let lastChangesRequestedTime: string | null = null;
  let lastApprovalTime: string | null = null;

  for (const review of sortedReviews) {
    // First review detection
    if (!firstReviewFound) {
      firstReviewFound = true;
      const duration = calculateDaysDiff(pr.created_at, review.submitted_at);
      stageDurations.pr_raised_to_first_review = duration;
      
      events.push({
        event_type: 'first_review',
        timestamp: review.submitted_at,
        actor: review.reviewer_username,
        details: review.review_state
      });

      stages.push({
        stage: 'first_review',
        timestamp: review.submitted_at,
        duration_from_previous: duration
      });
    }

    // Track review cycles for changes requested
    if (review.review_state === 'changes_requested') {
      currentCycle++;
      lastChangesRequestedTime = review.submitted_at;
      
      events.push({
        event_type: 'changes_requested',
        timestamp: review.submitted_at,
        actor: review.reviewer_username
      });

      // Look for subsequent updates (commits, file changes) that indicate changes were addressed
      const changesAddressedTime = findChangesAddressedTime(pr, review.submitted_at, sortedReviews);
      
      reviewCycles.push({
        cycle_number: currentCycle,
        changes_requested_at: review.submitted_at,
        changes_addressed_at: changesAddressedTime,
        duration_days: changesAddressedTime ? calculateDaysDiff(review.submitted_at, changesAddressedTime) : 0,
        reviewer: review.reviewer_username
      });

      if (changesAddressedTime) {
        events.push({
          event_type: 'changes_addressed',
          timestamp: changesAddressedTime,
          actor: pr.author
        });
      }
    }

    // Track approvals
    if (review.review_state === 'approved') {
      lastApprovalTime = review.submitted_at;
      
      events.push({
        event_type: 'approved',
        timestamp: review.submitted_at,
        actor: review.reviewer_username
      });
    }
  }

  // Calculate stage durations more accurately
  if (lastChangesRequestedTime && reviewCycles.length > 0) {
    // Use the last cycle's completion time for "comments fixed"
    const lastCycle = reviewCycles[reviewCycles.length - 1];
    if (lastCycle.changes_addressed_at) {
      const commentsFixedTime = lastCycle.changes_addressed_at;
      const baseTime = stages.find(s => s.stage === 'first_review')?.timestamp || pr.created_at;
      const duration = calculateDaysDiff(baseTime, commentsFixedTime);
      
      stageDurations.first_review_to_comments_fixed = duration;
      
      stages.push({
        stage: 'comments_fixed',
        timestamp: commentsFixedTime,
        duration_from_previous: duration
      });
    } else {
      issues.push('Changes were requested but no clear resolution detected');
      confidenceScore -= 0.2;
    }
  }

  // Approval stage
  if (lastApprovalTime) {
    const commentsFixedStage = stages.find(s => s.stage === 'comments_fixed');
    const baseTime = commentsFixedStage?.timestamp || 
                    stages.find(s => s.stage === 'first_review')?.timestamp || 
                    pr.created_at;
    
    const duration = calculateDaysDiff(baseTime, lastApprovalTime);
    stageDurations.comments_fixed_to_approved = duration;
    
    // Only add approved stage if it doesn't already exist
    if (!stages.find(s => s.stage === 'approved')) {
      stages.push({
        stage: 'approved',
        timestamp: lastApprovalTime,
        duration_from_previous: duration
      });
    }
  }

  // Merge stage
  if (pr.merged_at) {
    const approvedStage = stages.find(s => s.stage === 'approved');
    const baseTime = approvedStage?.timestamp || 
                    stages.find(s => s.stage === 'comments_fixed')?.timestamp ||
                    stages.find(s => s.stage === 'first_review')?.timestamp || 
                    pr.created_at;
    
    const duration = calculateDaysDiff(baseTime, pr.merged_at);
    stageDurations.approved_to_merged = duration;
    
    events.push({
      event_type: 'merged',
      timestamp: pr.merged_at,
      actor: 'system'
    });

    stages.push({
      stage: 'merged',
      timestamp: pr.merged_at,
      duration_from_previous: duration
    });
  }

  // Calculate total duration and ongoing time for open PRs
  const endTime = pr.merged_at || new Date().toISOString();
  const totalDuration = calculateDaysDiff(pr.created_at, endTime);
  stageDurations.total_review_time = totalDuration;

  // Calculate ongoing time for open PRs
  if (!pr.merged_at) {
    const lastActivityTime = stages.length > 1 ? stages[stages.length - 1].timestamp : pr.created_at;
    stageDurations.ongoing_time = calculateDaysDiff(lastActivityTime, new Date().toISOString());
  }

  // Create milestones object
  const milestones = {
    pr_created: { timestamp: pr.created_at, achieved: true },
    first_review: { 
      timestamp: stages.find(s => s.stage === 'first_review')?.timestamp || null, 
      achieved: !!stages.find(s => s.stage === 'first_review') 
    },
    approved: { 
      timestamp: lastApprovalTime, 
      achieved: !!lastApprovalTime 
    },
    merged: { 
      timestamp: pr.merged_at, 
      achieved: pr.status === 'merged' 
    }
  };

  // Validate timeline logic
  const validation = validateTimeline(stages, events, reviewCycles, issues, confidenceScore);

  return {
    pr_number: pr.github_pr_number,
    pr_title: pr.title,
    pr_author: pr.author,
    total_duration: totalDuration,
    stages,
    is_completed: pr.status === 'merged' || pr.status === 'closed',
    stage_durations: stageDurations,
    milestones,
    validation,
    review_cycles: reviewCycles,
    actual_events: events
  };
}

// Helper function to find when changes were actually addressed
function findChangesAddressedTime(pr: PullRequest, changesRequestedAt: string, allReviews: Review[]): string | null {
  const changesRequestedTime = new Date(changesRequestedAt);
  
  // Look for subsequent approvals or reviews after changes were requested
  const subsequentReviews = allReviews.filter(review => {
    const reviewTime = new Date(review.submitted_at);
    return reviewTime > changesRequestedTime && 
           (review.review_state === 'approved' || review.review_state === 'commented');
  });

  if (subsequentReviews.length > 0) {
    // Return the timestamp of the first subsequent review
    return subsequentReviews[0].submitted_at;
  }

  // Fallback: use PR updated time if it's after changes were requested
  const prUpdatedTime = new Date(pr.updated_at);
  if (prUpdatedTime > changesRequestedTime) {
    return pr.updated_at;
  }

  return null;
}

// Timeline validation function
function validateTimeline(
  stages: PRTimelineStage[], 
  events: TimelineEvent[], 
  reviewCycles: ReviewCycle[], 
  issues: string[], 
  confidenceScore: number
): PRTimelineValidation {
  const additionalIssues = [...issues];
  let adjustedConfidence = confidenceScore;

  // Check chronological order
  for (let i = 1; i < stages.length; i++) {
    const prevTime = new Date(stages[i-1].timestamp);
    const currTime = new Date(stages[i].timestamp);
    
    if (currTime < prevTime) {
      additionalIssues.push(`Stage ${stages[i].stage} occurs before ${stages[i-1].stage}`);
      adjustedConfidence -= 0.3;
    }
  }

  // Check for reasonable durations
  for (const stage of stages) {
    if (stage.duration_from_previous && stage.duration_from_previous < 0) {
      additionalIssues.push(`Negative duration detected for stage ${stage.stage}`);
      adjustedConfidence -= 0.2;
    }
    
    if (stage.duration_from_previous && stage.duration_from_previous > 30) {
      additionalIssues.push(`Unusually long duration (${stage.duration_from_previous} days) for stage ${stage.stage}`);
      adjustedConfidence -= 0.1;
    }
  }

  // Check review cycle consistency
  for (const cycle of reviewCycles) {
    if (cycle.duration_days > 14) {
      additionalIssues.push(`Review cycle ${cycle.cycle_number} took ${cycle.duration_days} days to address`);
      adjustedConfidence -= 0.05;
    }
  }

  // Determine data quality
  let dataQuality: 'high' | 'medium' | 'low';
  if (adjustedConfidence >= 0.8 && additionalIssues.length === 0) {
    dataQuality = 'high';
  } else if (adjustedConfidence >= 0.6 && additionalIssues.length <= 2) {
    dataQuality = 'medium';
  } else {
    dataQuality = 'low';
  }

  return {
    is_valid: adjustedConfidence >= 0.5 && additionalIssues.length < 5,
    confidence_score: Math.max(0, Math.min(1, adjustedConfidence)),
    issues: additionalIssues,
    data_quality: dataQuality
  };
}

// Helper function to get pending reviewers
function getPendingReviewers(prNumber: number, requestedReviewers: string[], prAuthor: string): string[] {
  const prReviews = reviews.filter(r => r.pr_id === prNumber && r.is_latest_review);
  const approvedReviewers = prReviews.filter(r => r.review_state === 'approved').map(r => r.reviewer_username);
  const changesRequestedReviewers = prReviews.filter(r => r.review_state === 'changes_requested').map(r => r.reviewer_username);
  const commentedReviewers = prReviews.filter(r => r.review_state === 'commented').map(r => r.reviewer_username);
  
  // Filter out PR author from all reviewer lists (authors can't review their own PRs)
  const filteredRequestedReviewers = requestedReviewers.filter(reviewer => reviewer !== prAuthor);
  const filteredChangesRequestedReviewers = changesRequestedReviewers.filter(reviewer => reviewer !== prAuthor);
  const filteredCommentedReviewers = commentedReviewers.filter(reviewer => reviewer !== prAuthor);
  
  console.log(`   🔍 PR #${prNumber} author: ${prAuthor} - filtering from reviewer lists`);
  if (requestedReviewers.length !== filteredRequestedReviewers.length) {
    console.log(`   ✂️ Removed PR author from requested reviewers: ${requestedReviewers.length} → ${filteredRequestedReviewers.length}`);
  }
  
  // Combine requested reviewers with reviewers who have engaged but not approved
  const allPendingReviewers = new Set<string>();
  
  // Add requested reviewers who haven't approved yet (excluding PR author)
  filteredRequestedReviewers.forEach(reviewer => {
    if (!approvedReviewers.includes(reviewer)) {
      allPendingReviewers.add(reviewer);
    }
  });
  
  // Add reviewers who requested changes (they need to re-approve, excluding PR author)
  filteredChangesRequestedReviewers.forEach(reviewer => {
    allPendingReviewers.add(reviewer);
  });
  
  // Add reviewers who only commented but didn't approve (excluding PR author)
  filteredCommentedReviewers.forEach(reviewer => {
    if (!approvedReviewers.includes(reviewer)) {
      allPendingReviewers.add(reviewer);
    }
  });
  
  return Array.from(allPendingReviewers);
}

// Helper function to determine programming language from file extension
function getLanguageFromPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languageMap: { [key: string]: string } = {
    'rs': 'rust',
    'js': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'jsx': 'javascript',
    'py': 'python',
    'java': 'java',
    'go': 'go',
    'cpp': 'cpp',
    'c': 'c',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'rb': 'ruby',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'sql': 'sql',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'md': 'markdown',
    'sh': 'bash',
    'dockerfile': 'dockerfile'
  };
  return languageMap[extension || ''] || 'text';
}

// Helper function to fetch code context for a comment
async function fetchCodeContext(comment: Comment, prNumber: number): Promise<CodeContext | null> {
  if (!comment.file_path || !comment.line_number) {
    return null;
  }

  try {
    console.log(`🔍 Fetching code context for ${comment.file_path}:${comment.line_number}`);
    
    // Fetch file content from GitHub API
    const { data: fileData } = await octokit.rest.repos.getContent({
      owner: 'juspay',
      repo: 'hyperswitch',
      path: comment.file_path,
      ref: `pull/${prNumber}/head` // Get the PR's version of the file
    });

    // Handle the case where the API returns an array (directory) or file content
    if (Array.isArray(fileData) || fileData.type !== 'file') {
      console.log(`⚠️ Skipping ${comment.file_path} - not a file or is a directory`);
      return null;
    }

    // Decode base64 content
    const fileContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const lines = fileContent.split('\n');

    // Calculate context range (5 lines before and after the comment line)
    const contextLines = 5;
    const startLine = Math.max(0, comment.line_number - contextLines - 1); // -1 for 0-based indexing
    const endLine = Math.min(lines.length, comment.line_number + contextLines);

    // Extract the relevant lines
    const codeSnippet = lines.slice(startLine, endLine).join('\n');
    const contextRange = `${startLine + 1}-${endLine}`;

    // Determine programming language
    const language = getLanguageFromPath(comment.file_path);

    console.log(`✅ Successfully fetched code context for ${comment.file_path}:${comment.line_number} (${contextRange})`);

    return {
      file_path: comment.file_path,
      line_number: comment.line_number,
      code_snippet: codeSnippet,
      context_range: contextRange,
      language: language
    };

  } catch (error) {
    console.error(`❌ Failed to fetch code context for ${comment.file_path}:${comment.line_number}:`, error);
    return null;
  }
}

// Cache for code contexts to avoid repeated API calls
const codeContextCache = new Map<string, CodeContext | null>();

// Helper function to get cached code context or fetch if not cached
async function getCachedCodeContext(comment: Comment, prNumber: number): Promise<CodeContext | null> {
  if (!comment.file_path || !comment.line_number) {
    return null;
  }

  const cacheKey = `${prNumber}:${comment.file_path}:${comment.line_number}`;
  
  if (codeContextCache.has(cacheKey)) {
    return codeContextCache.get(cacheKey) || null;
  }

  const context = await fetchCodeContext(comment, prNumber);
  codeContextCache.set(cacheKey, context);
  return context;
}

// Background summary generation for improved performance
async function generateBackgroundSummaries() {
  console.log('🤖 Starting background summary generation...');
  
  // Get PRs that don't have summaries or have been updated since last summary
  const prsNeedingSummaries = pullRequests.filter(pr => {
    if (!prSummaries.has(pr.github_pr_number)) {
      return true; // No summary exists
    }
    
    // Check if PR was updated after summary was generated
    const summary = prSummaries.get(pr.github_pr_number);
    const prUpdated = new Date(pr.updated_at);
    const summaryGenerated = new Date(summary?.metadata.generated_at || 0);
    
    return prUpdated > summaryGenerated;
  });
  
  console.log(`📊 Found ${prsNeedingSummaries.length} PRs needing summary generation`);
  
  // Generate summaries for PRs that need them (limit to 3 at a time to avoid overwhelming Gemini API)
  const batchSize = 3;
  for (let i = 0; i < Math.min(prsNeedingSummaries.length, batchSize); i++) {
    const pr = prsNeedingSummaries[i];
    
    try {
      console.log(`🔄 Background generating summary for PR #${pr.github_pr_number}: "${pr.title}"`);
      
      // Get comments and reviews for this PR
      const allComments = comments.filter(c => c.pr_id === pr.github_pr_number);
      const allReviews = reviews.filter(r => r.pr_id === pr.github_pr_number);
      
      // Filter out bot comments and reviews
      const humanComments = allComments.filter(isHumanComment);
      const humanReviews = allReviews.filter(isHumanReview);
      
      // Determine analysis strategy
      const strategy = determineAnalysisStrategy(allComments, allReviews);
      
      let summary;
      
      if (strategy.type === 'code_only') {
        // Generate code-only analysis
        summary = {
          summary: {
            executive: `This PR contains code changes without human discussion. Analysis based on code structure and commit messages.`,
            technical_feedback: [],
            rl_insights: {
              current_approach_analysis: "Code-only analysis: Unable to assess current approach without discussion context.",
              improvement_opportunities: ["Consider adding more detailed PR description", "Request code review from team members"],
              risk_assessment: "Medium risk due to lack of peer review discussion.",
              recommended_experiments: ["Add unit tests", "Consider integration testing"]
            },
            action_items: [
              {
                description: "Request human code review",
                priority: "high" as const,
                estimated_effort: "1-2 hours",
                blocking: false
              }
            ],
            sentiment_analysis: {
              overall_tone: "neutral" as const,
              reviewer_confidence: "low" as const,
              consensus_level: "weak" as const
            }
          },
          metadata: {
            generated_at: new Date().toISOString(),
            model_used: 'code-analysis',
            token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            confidence_score: 0.3,
            analysis_strategy: strategy,
            background_generated: true
          }
        };
      } else if (humanComments.length > 0 || humanReviews.length > 0) {
        // Generate discussion-based summary using Gemini
        summary = await geminiService.generatePRSummary(pr, humanComments, humanReviews);
        summary.metadata.analysis_strategy = strategy;
        summary.metadata.background_generated = true;
      } else {
        console.log(`⏭️ Skipping PR #${pr.github_pr_number} - no meaningful content for analysis`);
        continue;
      }
      
      // Cache the summary
      prSummaries.set(pr.github_pr_number, summary);
      
      // Broadcast update to connected clients
      broadcastUpdate({ 
        type: 'summary_generated', 
        data: { prNumber: pr.github_pr_number, summary } 
      });
      
      console.log(`✅ Background summary generated for PR #${pr.github_pr_number}`);
      
      // Small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`❌ Error generating background summary for PR #${pr.github_pr_number}:`, error);
    }
  }
  
  console.log(`🎉 Background summary generation completed`);
}

// Fetch PRs from GitHub
async function fetchConnectorPRs() {
  try {
    console.log('🔍 Starting PR fetch from GitHub...');
    
    // Calculate date for filtering (last 60 days)
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const dateFilter = sixtyDaysAgo.toISOString();
    
    console.log(`📅 Fetching PRs from the last 60 days (since ${dateFilter.split('T')[0]})`);
    
    const { data: prs } = await octokit.rest.pulls.list({
      owner: 'juspay',
      repo: 'hyperswitch',
      state: 'all', // Changed from 'open' to 'all'
      per_page: 100,
      sort: 'updated',
      direction: 'desc'
    });
    
    // Filter PRs by date (last 60 days)
    const recentPRs = prs.filter(pr => {
      const prDate = new Date(pr.updated_at);
      return prDate >= sixtyDaysAgo;
    });
    
    console.log(`📊 Total PRs fetched from GitHub: ${prs.length}`);
    console.log(`📅 PRs from last 60 days: ${recentPRs.length}`);
    
    // Analyze all labels to understand what's available (using recent PRs for analysis)
    const allLabels = new Set<string>();
    const labelStats = new Map<string, number>();
    
    recentPRs.forEach(pr => {
      pr.labels.forEach((label: any) => {
        allLabels.add(label.name);
        labelStats.set(label.name, (labelStats.get(label.name) || 0) + 1);
      });
    });
    
    console.log(`🏷️  Total unique labels found: ${allLabels.size}`);
    console.log('📈 Top 10 most common labels:');
    const sortedLabels = Array.from(labelStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    sortedLabels.forEach(([label, count]) => {
      console.log(`   - ${label}: ${count} PRs`);
    });
    
    // Check for connector-related labels
    const connectorLabels = Array.from(allLabels).filter(label => 
      label.toLowerCase().includes('connector') || 
      label.toLowerCase().includes('integration')
    );
    console.log(`🔌 Connector-related labels found: ${connectorLabels.join(', ')}`);

    const connectorPRs = prs.filter(isConnectorIntegrationPR);
    console.log(`✅ PRs matching connector filter: ${connectorPRs.length}`);
    
    // Log details about filtered PRs
    connectorPRs.forEach(pr => {
      console.log(`   - PR #${pr.number}: "${pr.title}" (Labels: ${pr.labels.map((l: any) => l.name).join(', ')})`);
    });
    
    pullRequests = connectorPRs.map(pr => ({
      id: pr.number,
      github_pr_number: pr.number,
      title: pr.title,
      author: pr.user?.login || 'unknown',
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      merged_at: pr.merged_at,
      status: pr.state as 'open' | 'merged' | 'closed',
      is_connector_integration: true,
      current_approvals_count: 0, // Will be updated after fetching reviews
      labels: pr.labels.map((label: any) => label.name),
      reviewers: [],
      requested_reviewers: [],
      pending_reviewers: [],
      url: pr.html_url,
    }));

    // Fetch detailed information for each PR (including requested reviewers)
    console.log('🔄 Fetching detailed information for each PR...');
    for (const pr of pullRequests) {
      try {
        // Fetch detailed PR information to get requested reviewers
        const { data: detailedPR } = await octokit.rest.pulls.get({
          owner: 'juspay',
          repo: 'hyperswitch',
          pull_number: pr.github_pr_number,
        });

        // Extract requested reviewers
        const requestedReviewers = detailedPR.requested_reviewers?.map((reviewer: any) => reviewer.login) || [];
        const requestedTeams = detailedPR.requested_teams?.map((team: any) => team.name) || [];
        
        // Store requested reviewers (combine individual reviewers and team names)
        pr.requested_reviewers = [...requestedReviewers, ...requestedTeams];
        
        console.log(`   - PR #${pr.github_pr_number}: ${requestedReviewers.length} requested reviewers, ${requestedTeams.length} requested teams`);
        
        // Fetch reviews for this PR
        await fetchPRReviews(pr.github_pr_number);
        
        // Update approval count and calculate pending reviewers
        pr.current_approvals_count = countApprovals(pr.github_pr_number);
        pr.pending_reviewers = getPendingReviewers(pr.github_pr_number, pr.requested_reviewers, pr.author);
        
      } catch (error) {
        console.error(`❌ Error fetching detailed info for PR #${pr.github_pr_number}:`, error);
        // Set defaults if fetch fails
        pr.requested_reviewers = [];
        pr.pending_reviewers = [];
        pr.current_approvals_count = 0;
      }
    }

    console.log(`✨ Successfully processed ${pullRequests.length} connector integration PRs`);
    broadcastUpdate({ type: 'prs_updated', data: pullRequests });
    
    // Trigger background summary and categorization generation after PR data is updated
    setTimeout(() => {
      generateBackgroundSummaries().catch(error => {
        console.error('❌ Error in background summary generation:', error);
      });
      
      // Also trigger background categorization if cache is invalid or doesn't exist
      if (!isCacheValid(commentCategorizationCache)) {
        generateBackgroundCategorization().catch(error => {
          console.error('❌ Error in background categorization generation:', error);
        });
      }
    }, 2000); // Small delay to ensure all data is processed
    
  } catch (error) {
    console.error('❌ Error fetching PRs:', error);
  }
}

// Fetch reviews for a specific PR
async function fetchPRReviews(prNumber: number) {
  try {
    const { data: prReviews } = await octokit.rest.pulls.listReviews({
      owner: 'juspay',
      repo: 'hyperswitch',
      pull_number: prNumber,
    });

    // Clear existing reviews for this PR
    reviews = reviews.filter(r => r.pr_id !== prNumber);

    // Track latest review per reviewer
    const latestReviews = new Map<string, any>();
    
    prReviews.forEach(review => {
      if (review.user?.login) {
        latestReviews.set(review.user.login, review);
      }
    });

    // Add reviews to storage with actual content and normalized states
    latestReviews.forEach((review, reviewer) => {
      const normalizedState = normalizeReviewState(review.state);
      console.log(`   📝 Review by ${reviewer}: ${review.state} → ${normalizedState}`);
      
      reviews.push({
        id: review.id,
        pr_id: prNumber,
        reviewer_username: reviewer,
        review_state: normalizedState,
        submitted_at: review.submitted_at,
        is_latest_review: true,
        content: review.body || '', // Add the actual review content
      });
    });

    // Also fetch review comments (inline code comments)
    await fetchPRReviewComments(prNumber);

  } catch (error) {
    console.error(`Error fetching reviews for PR ${prNumber}:`, error);
  }
}

// Fetch review comments (inline code comments) for a specific PR
async function fetchPRReviewComments(prNumber: number) {
  try {
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: 'juspay',
      repo: 'hyperswitch',
      pull_number: prNumber,
    });

    console.log(`📝 Fetched ${reviewComments.length} review comments for PR #${prNumber}`);

    // Add review comments to the comments array with code context
    for (const comment of reviewComments) {
      // Check if this comment already exists to avoid duplicates
      const existingComment = comments.find(c => c.github_comment_id === comment.id);
      if (!existingComment) {
        console.log(`   - Review comment on ${comment.path}:${comment.line || comment.original_line} by ${comment.user?.login}`);
        
        // Create the comment object first
        const newComment: Comment = {
          id: comment.id,
          pr_id: prNumber,
          github_comment_id: comment.id,
          author: comment.user?.login || 'unknown',
          content: comment.body || '',
          created_at: comment.created_at,
          is_resolved: false, // GitHub doesn't provide this info directly for review comments
          comment_type: 'review',
          // Add code context fields
          file_path: comment.path || null,
          line_number: comment.line || null,
          diff_hunk: comment.diff_hunk || null,
          original_line: comment.original_line || null,
          side: comment.side as 'LEFT' | 'RIGHT' || null,
        };

        // Fetch code context for this comment
        try {
          const codeContext = await getCachedCodeContext(newComment, prNumber);
          newComment.code_context = codeContext;
          if (codeContext) {
            console.log(`   ✅ Added code context for ${comment.path}:${comment.line || comment.original_line}`);
          }
        } catch (contextError) {
          console.error(`   ❌ Failed to fetch code context for ${comment.path}:${comment.line || comment.original_line}:`, contextError);
          newComment.code_context = null;
        }

        comments.push(newComment);
      }
    }

  } catch (error) {
    console.error(`Error fetching review comments for PR ${prNumber}:`, error);
  }
}

// Fetch comments for a specific PR
async function fetchPRComments(prNumber: number) {
  try {
    const { data: prComments } = await octokit.rest.issues.listComments({
      owner: 'juspay',
      repo: 'hyperswitch',
      issue_number: prNumber,
    });

    // Clear existing general/issue comments for this PR (but keep review comments)
    comments = comments.filter(c => c.pr_id !== prNumber || c.comment_type === 'review');

    // Add issue comments to storage
    prComments.forEach(comment => {
      // Check if this comment already exists to avoid duplicates
      const existingComment = comments.find(c => c.github_comment_id === comment.id);
      if (!existingComment) {
        comments.push({
          id: comment.id,
          pr_id: prNumber,
          github_comment_id: comment.id,
          author: comment.user?.login || 'unknown',
          content: comment.body || '',
          created_at: comment.created_at,
          is_resolved: false, // GitHub doesn't provide this info directly
          comment_type: 'general',
        });
      }
    });

  } catch (error) {
    console.error(`Error fetching comments for PR ${prNumber}:`, error);
  }
}

// WebSocket broadcast function
function broadcastUpdate(message: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// API Routes
app.get('/api/prs', (req, res) => {
  res.json(pullRequests);
});

app.get('/api/prs/:prNumber/reviews', (req, res) => {
  const prNumber = parseInt(req.params.prNumber);
  const prReviews = reviews.filter(r => r.pr_id === prNumber);
  res.json(prReviews);
});

app.get('/api/prs/:prNumber/comments', async (req, res) => {
  const prNumber = parseInt(req.params.prNumber);
  
  // Fetch fresh comments from GitHub
  await fetchPRComments(prNumber);
  
  const prComments = comments.filter(c => c.pr_id === prNumber);
  res.json(prComments);
});

app.get('/api/analytics', (req, res) => {
  const analytics = {
    totalPRs: pullRequests.length,
    openPRs: pullRequests.filter(pr => pr.status === 'open').length,
    averageApprovals: pullRequests.length > 0 
      ? pullRequests.reduce((sum, pr) => sum + pr.current_approvals_count, 0) / pullRequests.length 
      : 0,
    prsNeedingReview: pullRequests.filter(pr => pr.current_approvals_count === 0).length,
    prsWithFeedback: pullRequests.filter(pr => {
      const prReviews = reviews.filter(r => r.pr_id === pr.github_pr_number);
      return prReviews.some(r => r.review_state === 'changes_requested');
    }).length,
  };
  
  res.json(analytics);
});

// Timeline Analytics Endpoint
app.get('/api/analytics/timeline', (req, res) => {
  try {
    console.log('📊 Generating timeline analytics for all PRs...');
    
    // Calculate timeline for each PR
    const timelineData: PRTimeline[] = pullRequests.map(pr => {
      const prReviews = reviews.filter(r => r.pr_id === pr.github_pr_number);
      const prComments = comments.filter(c => c.pr_id === pr.github_pr_number);
      
      return calculatePRTimeline(pr, prReviews, prComments);
    });

    // Sort by total duration for better visualization
    const sortedTimelineData = timelineData.sort((a, b) => b.total_duration - a.total_duration);

    // Calculate summary statistics
    const completedPRs = timelineData.filter(t => t.is_completed);
    const avgTotalTime = completedPRs.length > 0 
      ? completedPRs.reduce((sum, t) => sum + t.total_duration, 0) / completedPRs.length 
      : 0;

    const avgFirstReviewTime = timelineData
      .filter(t => t.stage_durations.pr_raised_to_first_review > 0)
      .reduce((sum, t, _, arr) => sum + t.stage_durations.pr_raised_to_first_review / arr.length, 0);

    const avgApprovalTime = completedPRs
      .filter(t => t.stage_durations.comments_fixed_to_approved > 0)
      .reduce((sum, t, _, arr) => sum + t.stage_durations.comments_fixed_to_approved / arr.length, 0);

    // Calculate enhanced timeline data with validation
    const enhancedTimelineData: EnhancedPRTimeline[] = pullRequests.map(pr => {
      const prReviews = reviews.filter(r => r.pr_id === pr.github_pr_number);
      const prComments = comments.filter(c => c.pr_id === pr.github_pr_number);
      
      return calculateEnhancedPRTimeline(pr, prReviews, prComments);
    });

    // Calculate data quality metrics
    const qualityMetrics = {
      high_quality: enhancedTimelineData.filter(t => t.validation.data_quality === 'high').length,
      medium_quality: enhancedTimelineData.filter(t => t.validation.data_quality === 'medium').length,
      low_quality: enhancedTimelineData.filter(t => t.validation.data_quality === 'low').length,
      invalid_timelines: enhancedTimelineData.filter(t => !t.validation.is_valid).length,
      avg_confidence_score: enhancedTimelineData.reduce((sum, t) => sum + t.validation.confidence_score, 0) / enhancedTimelineData.length,
      total_issues_detected: enhancedTimelineData.reduce((sum, t) => sum + t.validation.issues.length, 0),
      review_cycles_total: enhancedTimelineData.reduce((sum, t) => sum + t.review_cycles.length, 0)
    };

    const summary = {
      total_prs_analyzed: timelineData.length,
      completed_prs: completedPRs.length,
      avg_total_time_days: Math.round(avgTotalTime * 10) / 10,
      avg_first_review_time_days: Math.round(avgFirstReviewTime * 10) / 10,
      avg_approval_time_days: Math.round(avgApprovalTime * 10) / 10,
      longest_pr: sortedTimelineData[0] || null,
      fastest_pr: completedPRs.sort((a, b) => a.total_duration - b.total_duration)[0] || null,
      data_quality: qualityMetrics
    };

    console.log(`✅ Generated timeline for ${timelineData.length} PRs`);
    console.log(`📈 Summary: Avg total time ${summary.avg_total_time_days}d, First review ${summary.avg_first_review_time_days}d`);
    console.log(`🔍 Data Quality: ${qualityMetrics.high_quality} high, ${qualityMetrics.medium_quality} medium, ${qualityMetrics.low_quality} low quality timelines`);

    res.json({
      timeline_data: sortedTimelineData,
      enhanced_timeline_data: enhancedTimelineData,
      summary: summary,
      generated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error generating timeline analytics:', error);
    res.status(500).json({ 
      error: 'Failed to generate timeline analytics',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Gemini AI Summary Endpoints
app.get('/api/prs/:prNumber/summary', async (req, res) => {
  try {
    const prNumber = parseInt(req.params.prNumber);
    
    // Check if summary already exists
    if (prSummaries.has(prNumber)) {
      const existingSummary = prSummaries.get(prNumber);
      console.log(`📋 Returning cached summary for PR #${prNumber}`);
      return res.json(existingSummary);
    }

    // Find the PR
    const pr = pullRequests.find(p => p.github_pr_number === prNumber);
    if (!pr) {
      return res.status(404).json({ error: 'PR not found' });
    }

    // Get comments and reviews for this PR
    const allComments = comments.filter(c => c.pr_id === prNumber);
    const allReviews = reviews.filter(r => r.pr_id === prNumber);

    // Filter out bot comments and reviews
    const humanComments = allComments.filter(isHumanComment);
    const humanReviews = allReviews.filter(isHumanReview);
    const botComments = allComments.filter(c => !isHumanComment(c));
    const botReviews = allReviews.filter(r => !isHumanReview(r));

    // Determine analysis strategy
    const strategy = determineAnalysisStrategy(allComments, allReviews);
    
    console.log(`🤖 PR #${prNumber} Analysis Strategy: ${strategy.type}`);
    console.log(`   👥 Human: ${strategy.human_comments} comments, ${strategy.human_reviews} reviews`);
    console.log(`   🤖 Bot: ${strategy.bot_comments} comments, ${strategy.bot_reviews} reviews`);
    console.log(`   🎯 Confidence: ${strategy.confidence_level}`);

    let summary;

    if (strategy.type === 'code_only') {
      // No meaningful human discussion - analyze code only
      console.log(`🔍 Generating code-only analysis for PR #${prNumber}`);
      
      // For now, return a structured response indicating code-only analysis
      // TODO: Implement actual code analysis in Phase 3
      summary = {
        summary: {
          executive: `This PR contains code changes without human discussion. Analysis based on code structure and commit messages.`,
          technical_feedback: [],
          rl_insights: {
            current_approach_analysis: "Code-only analysis: Unable to assess current approach without discussion context.",
            improvement_opportunities: ["Consider adding more detailed PR description", "Request code review from team members"],
            risk_assessment: "Medium risk due to lack of peer review discussion.",
            recommended_experiments: ["Add unit tests", "Consider integration testing"]
          },
          action_items: [
            {
              description: "Request human code review",
              priority: "high" as const,
              estimated_effort: "1-2 hours",
              blocking: false
            }
          ],
          sentiment_analysis: {
            overall_tone: "neutral" as const,
            reviewer_confidence: "low" as const,
            consensus_level: "weak" as const
          }
        },
        metadata: {
          generated_at: new Date().toISOString(),
          model_used: 'code-analysis',
          token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          confidence_score: 0.3,
          analysis_strategy: strategy
        }
      };
    } else {
      // Human discussion available - use existing analysis
      if (humanComments.length === 0 && humanReviews.length === 0) {
        return res.status(400).json({ 
          error: 'No meaningful human discussion available for analysis',
          message: 'This PR only contains automated comments. Code-only analysis will be implemented soon.',
          strategy: strategy
        });
      }

      console.log(`🤖 Generating discussion-based summary for PR #${prNumber} with ${humanComments.length} human comments and ${humanReviews.length} human reviews`);

      // Generate summary using Gemini with filtered human content
      summary = await geminiService.generatePRSummary(pr, humanComments, humanReviews);
      
      // Add strategy information to metadata
      summary.metadata.analysis_strategy = strategy;
    }
    
    // Cache the summary
    prSummaries.set(prNumber, summary);
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'summary_generated', 
      data: { prNumber, summary } 
    });

    console.log(`✅ Successfully generated ${strategy.type} summary for PR #${prNumber}`);
    res.json(summary);

  } catch (error) {
    console.error(`❌ Error generating summary for PR #${req.params.prNumber}:`, error);
    res.status(500).json({ 
      error: 'Failed to generate summary',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/api/prs/:prNumber/summary/regenerate', async (req, res) => {
  try {
    const prNumber = parseInt(req.params.prNumber);
    
    // Find the PR
    const pr = pullRequests.find(p => p.github_pr_number === prNumber);
    if (!pr) {
      return res.status(404).json({ error: 'PR not found' });
    }

    // Get fresh comments and reviews
    await fetchPRComments(prNumber);
    await fetchPRReviewComments(prNumber);
    
    const prComments = comments.filter(c => c.pr_id === prNumber);
    const prReviews = reviews.filter(r => r.pr_id === prNumber);

    if (prComments.length === 0 && prReviews.length === 0) {
      return res.status(400).json({ 
        error: 'No comments or reviews available for summarization',
        message: 'This PR has no discussion content to analyze.'
      });
    }

    console.log(`🔄 Regenerating AI summary for PR #${prNumber}`);

    // Remove existing summary
    prSummaries.delete(prNumber);

    // Generate new summary
    const summary = await geminiService.generatePRSummary(pr, prComments, prReviews);
    
    // Cache the new summary
    prSummaries.set(prNumber, summary);
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'summary_regenerated', 
      data: { prNumber, summary } 
    });

    console.log(`✅ Successfully regenerated summary for PR #${prNumber}`);
    res.json(summary);

  } catch (error) {
    console.error(`❌ Error regenerating summary for PR #${req.params.prNumber}:`, error);
    res.status(500).json({ 
      error: 'Failed to regenerate summary',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/api/prs/:prNumber/summary/status', (req, res) => {
  const prNumber = parseInt(req.params.prNumber);
  const hasSummary = prSummaries.has(prNumber);
  
  if (hasSummary) {
    const summary = prSummaries.get(prNumber);
    res.json({
      exists: true,
      generated_at: summary?.metadata.generated_at,
      confidence_score: summary?.metadata.confidence_score,
      token_usage: summary?.metadata.token_usage,
      background_generated: summary?.metadata.background_generated || false
    });
  } else {
    res.json({
      exists: false,
      message: 'No summary available for this PR'
    });
  }
});

// Bulk summary status endpoint for performance
app.get('/api/summaries/status', (req, res) => {
  const summaryStatus = pullRequests.map(pr => {
    const hasSummary = prSummaries.has(pr.github_pr_number);
    const summary = prSummaries.get(pr.github_pr_number);
    
    return {
      pr_number: pr.github_pr_number,
      title: pr.title,
      has_summary: hasSummary,
      generated_at: summary?.metadata.generated_at || null,
      background_generated: summary?.metadata.background_generated || false,
      confidence_score: summary?.metadata.confidence_score || null
    };
  });
  
  const stats = {
    total_prs: pullRequests.length,
    cached_summaries: summaryStatus.filter(s => s.has_summary).length,
    background_generated: summaryStatus.filter(s => s.background_generated).length,
    manual_generated: summaryStatus.filter(s => s.has_summary && !s.background_generated).length
  };
  
  res.json({
    summary_status: summaryStatus,
    statistics: stats
  });
});

// Common Learning Endpoints
app.get('/api/common-learning', async (req, res) => {
  try {
    // Check if common learning already exists and is recent (less than 1 hour old)
    if (commonLearning) {
      const lastUpdated = new Date(commonLearning.metadata.last_updated);
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);
      
      if (lastUpdated > oneHourAgo) {
        console.log('📋 Returning cached common learning insights');
        return res.json(commonLearning);
      }
    }

    console.log('🧠 Generating common learning insights from all PRs...');
    console.log(`📊 Analyzing ${pullRequests.length} PRs, ${comments.length} comments, ${reviews.length} reviews`);

    // Filter out bot comments and reviews for better analysis
    const humanComments = comments.filter(isHumanComment);
    const humanReviews = reviews.filter(isHumanReview);
    const botComments = comments.filter(c => !isHumanComment(c));
    const botReviews = reviews.filter(r => !isHumanReview(r));

    console.log(`🤖 Filtering results:`);
    console.log(`   👥 Human: ${humanComments.length} comments, ${humanReviews.length} reviews`);
    console.log(`   🤖 Bot: ${botComments.length} comments, ${botReviews.length} reviews (filtered out)`);

    // Check if there's enough data to analyze
    if (pullRequests.length === 0) {
      return res.status(400).json({ 
        error: 'No PR data available for analysis',
        message: 'Please wait for PR data to be loaded first.'
      });
    }

    // Generate common learning using Gemini with filtered human content
    const learning = await geminiService.generateCommonLearning(pullRequests, humanComments, humanReviews);
    
    // Cache the learning insights
    commonLearning = learning;
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'common_learning_generated', 
      data: learning 
    });

    console.log(`✅ Successfully generated common learning insights`);
    res.json(learning);

  } catch (error) {
    console.error(`❌ Error generating common learning:`, error);
    res.status(500).json({ 
      error: 'Failed to generate common learning',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/api/common-learning/regenerate', async (req, res) => {
  try {
    console.log('🔄 Regenerating common learning insights...');

    // Check if there's enough data to analyze
    if (pullRequests.length === 0) {
      return res.status(400).json({ 
        error: 'No PR data available for analysis',
        message: 'Please wait for PR data to be loaded first.'
      });
    }

    // Clear existing common learning
    commonLearning = null;

    // Generate new common learning
    const learning = await geminiService.generateCommonLearning(pullRequests, comments, reviews);
    
    // Cache the new learning insights
    commonLearning = learning;
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'common_learning_regenerated', 
      data: learning 
    });

    console.log(`✅ Successfully regenerated common learning insights`);
    res.json(learning);

  } catch (error) {
    console.error(`❌ Error regenerating common learning:`, error);
    res.status(500).json({ 
      error: 'Failed to regenerate common learning',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/api/common-learning/status', (req, res) => {
  if (commonLearning) {
    res.json({
      exists: true,
      last_updated: commonLearning.metadata.last_updated,
      confidence_score: commonLearning.metadata.confidence_score,
      analyzed_prs: commonLearning.metadata.analyzed_prs,
      total_comments: commonLearning.metadata.total_comments,
      total_reviews: commonLearning.metadata.total_reviews,
      analysis_timeframe: commonLearning.metadata.analysis_timeframe
    });
  } else {
    res.json({
      exists: false,
      message: 'No common learning insights available'
    });
  }
});

app.get('/api/common-learning/trends', (req, res) => {
  if (commonLearning) {
    res.json({
      trends: commonLearning.trends,
      recommendations: commonLearning.recommendations,
      metadata: {
        last_updated: commonLearning.metadata.last_updated,
        confidence_score: commonLearning.metadata.confidence_score
      }
    });
  } else {
    res.status(404).json({
      error: 'No common learning data available',
      message: 'Generate common learning insights first'
    });
  }
});

// Comment Categorization Endpoint with Caching
app.get('/api/analytics/comment-categorization', async (req, res) => {
  try {
    console.log('🔍 Comment categorization requested...');
    
    // Check cache first
    if (isCacheValid(commentCategorizationCache)) {
      console.log('📋 Returning cached comment categorization data');
      const cacheAge = Math.round((new Date().getTime() - new Date(commentCategorizationCache!.generated_at).getTime()) / (1000 * 60));
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Age', `${cacheAge}m`);
      res.setHeader('X-Data-Version', commentCategorizationCache!.version);
      return res.json({
        ...commentCategorizationCache!.data,
        cache_info: {
          from_cache: true,
          generated_at: commentCategorizationCache!.generated_at,
          expires_at: commentCategorizationCache!.expires_at,
          cache_age_minutes: cacheAge
        }
      });
    }

    console.log('🔄 Cache miss or invalid - generating fresh categorization...');
    console.log(`📊 Analyzing ${pullRequests.length} PRs with ${comments.length} total comments`);

    // Check if there's enough data to analyze
    if (pullRequests.length === 0) {
      return res.status(400).json({ 
        error: 'No PR data available for analysis',
        message: 'Please wait for PR data to be loaded first.'
      });
    }

    // Filter out bot comments for better analysis
    const humanComments = comments.filter(isHumanComment);
    const botComments = comments.filter(c => !isHumanComment(c));

    console.log(`🤖 Comment filtering results:`);
    console.log(`   👥 Human comments: ${humanComments.length}`);
    console.log(`   🤖 Bot comments: ${botComments.length} (filtered out)`);

    if (humanComments.length === 0) {
      return res.status(400).json({ 
        error: 'No human comments available for categorization',
        message: 'All comments appear to be automated. No meaningful categorization possible.',
        statistics: {
          total_comments: comments.length,
          human_comments: humanComments.length,
          bot_comments: botComments.length
        }
      });
    }

    // Generate comment categorization using Gemini
    const categorization = await geminiService.categorizeComments(pullRequests, humanComments);
    
    // Create and store cache entry
    commentCategorizationCache = createCacheEntry(categorization);
    
    // Broadcast update to connected clients
    broadcastUpdate({ 
      type: 'categorization_generated', 
      data: categorization 
    });
    
    console.log(`✅ Comment categorization completed and cached successfully`);
    console.log(`📈 Results: ${categorization.overall_summary.total_comments_categorized} comments categorized across ${categorization.overall_summary.total_prs_analyzed} PRs`);

    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('X-Data-Version', commentCategorizationCache.version);
    res.json({
      ...categorization,
      cache_info: {
        from_cache: false,
        generated_at: commentCategorizationCache.generated_at,
        expires_at: commentCategorizationCache.expires_at,
        cache_age_minutes: 0
      }
    });

  } catch (error) {
    console.error('❌ Error generating comment categorization:', error);
    res.status(500).json({ 
      error: 'Failed to generate comment categorization',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Cache management endpoints
app.get('/api/analytics/comment-categorization/cache/status', (req, res) => {
  if (commentCategorizationCache) {
    const now = new Date();
    const generated = new Date(commentCategorizationCache.generated_at);
    const expires = new Date(commentCategorizationCache.expires_at);
    const ageMinutes = Math.round((now.getTime() - generated.getTime()) / (1000 * 60));
    const expiresInMinutes = Math.round((expires.getTime() - now.getTime()) / (1000 * 60));
    const isValid = isCacheValid(commentCategorizationCache);
    
    res.json({
      cached: true,
      valid: isValid,
      generated_at: commentCategorizationCache.generated_at,
      expires_at: commentCategorizationCache.expires_at,
      version: commentCategorizationCache.version,
      age_minutes: ageMinutes,
      expires_in_minutes: Math.max(0, expiresInMinutes),
      data_summary: {
        total_prs: commentCategorizationCache.data.overall_summary.total_prs_analyzed,
        total_comments: commentCategorizationCache.data.overall_summary.total_comments_categorized,
        avg_confidence: commentCategorizationCache.data.overall_summary.avg_confidence_score
      }
    });
  } else {
    res.json({
      cached: false,
      valid: false,
      message: 'No cached data available'
    });
  }
});

app.post('/api/analytics/comment-categorization/cache/refresh', async (req, res) => {
  try {
    console.log('🔄 Manual cache refresh requested...');
    
    // Clear existing cache
    commentCategorizationCache = null;
    
    // Trigger background generation
    generateBackgroundCategorization().then(() => {
      broadcastUpdate({ 
        type: 'categorization_refresh_completed',
        data: { status: 'completed' }
      });
    }).catch(error => {
      console.error('❌ Error in manual cache refresh:', error);
      broadcastUpdate({ 
        type: 'categorization_refresh_failed',
        data: { error: error.message }
      });
    });
    
    res.json({
      status: 'refresh_initiated',
      message: 'Cache refresh started in background. New data will be available shortly.'
    });
    
  } catch (error) {
    console.error('❌ Error initiating cache refresh:', error);
    res.status(500).json({ 
      error: 'Failed to initiate cache refresh',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.delete('/api/analytics/comment-categorization/cache', (req, res) => {
  console.log('🗑️ Clearing comment categorization cache...');
  commentCategorizationCache = null;
  
  broadcastUpdate({ 
    type: 'categorization_cache_cleared',
    data: { timestamp: new Date().toISOString() }
  });
  
  res.json({
    status: 'cache_cleared',
    message: 'Comment categorization cache has been cleared.'
  });
});

// Test Gemini connection endpoint
app.get('/api/gemini/test', async (req, res) => {
  try {
    console.log('🧪 Testing Gemini AI connection...');
    const isConnected = await geminiService.testConnection();
    
    if (isConnected) {
      console.log('✅ Gemini AI connection successful');
      res.json({ 
        status: 'connected',
        message: 'Gemini AI is working correctly',
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'
      });
    } else {
      console.log('❌ Gemini AI connection failed');
      res.status(500).json({ 
        status: 'disconnected',
        message: 'Failed to connect to Gemini AI'
      });
    }
  } catch (error) {
    console.error('❌ Gemini test error:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Error testing Gemini connection',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Debug endpoint for specific PR review data
app.get('/api/debug/pr/:prNumber', (req, res) => {
  const prNumber = parseInt(req.params.prNumber);
  const pr = pullRequests.find(p => p.github_pr_number === prNumber);
  const prReviews = reviews.filter(r => r.pr_id === prNumber);
  
  if (!pr) {
    return res.status(404).json({ error: 'PR not found' });
  }
  
  const debugData = {
    pr: {
      number: pr.github_pr_number,
      title: pr.title,
      status: pr.status,
      current_approvals_count: pr.current_approvals_count,
      requested_reviewers: pr.requested_reviewers,
      pending_reviewers: pr.pending_reviewers
    },
    reviews: prReviews.map(r => ({
      reviewer: r.reviewer_username,
      state: r.review_state,
      submitted_at: r.submitted_at,
      is_latest: r.is_latest_review
    })),
    approval_calculation: {
      total_reviews: prReviews.length,
      approved_reviews: prReviews.filter(r => r.review_state === 'approved').length,
      changes_requested: prReviews.filter(r => r.review_state === 'changes_requested').length,
      commented: prReviews.filter(r => r.review_state === 'commented').length
    }
  };
  
  res.json(debugData);
});

// Enhanced debug endpoint for timeline validation
app.get('/api/debug/pr/:prNumber/timeline', (req, res) => {
  const prNumber = parseInt(req.params.prNumber);
  const pr = pullRequests.find(p => p.github_pr_number === prNumber);
  
  if (!pr) {
    return res.status(404).json({ error: 'PR not found' });
  }

  const prReviews = reviews.filter(r => r.pr_id === prNumber);
  const prComments = comments.filter(c => c.pr_id === prNumber);
  
  // Calculate both basic and enhanced timelines
  const basicTimeline = calculatePRTimeline(pr, prReviews, prComments);
  const enhancedTimeline = calculateEnhancedPRTimeline(pr, prReviews, prComments);
  
  const debugData = {
    pr_info: {
      number: pr.github_pr_number,
      title: pr.title,
      author: pr.author,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      merged_at: pr.merged_at,
      status: pr.status
    },
    basic_timeline: basicTimeline,
    enhanced_timeline: enhancedTimeline,
    raw_data: {
      reviews: prReviews.map(r => ({
        reviewer: r.reviewer_username,
        state: r.review_state,
        submitted_at: r.submitted_at,
        content_length: r.content?.length || 0
      })),
      comments: prComments.map(c => ({
        author: c.author,
        type: c.comment_type,
        created_at: c.created_at,
        content_length: c.content.length,
        file_path: c.file_path
      }))
    },
    validation_details: {
      issues_found: enhancedTimeline.validation.issues,
      confidence_score: enhancedTimeline.validation.confidence_score,
      data_quality: enhancedTimeline.validation.data_quality,
      is_valid: enhancedTimeline.validation.is_valid,
      review_cycles_count: enhancedTimeline.review_cycles.length,
      events_timeline: enhancedTimeline.actual_events
    }
  };
  
  res.json(debugData);
});

// Debug endpoint to understand PR filtering
app.get('/api/debug', async (req, res) => {
  try {
    console.log('🔍 Debug endpoint called - fetching fresh data...');
    
    // Fetch fresh data for debugging
    const { data: allPRs } = await octokit.rest.pulls.list({
      owner: 'juspay',
      repo: 'hyperswitch',
      state: 'open',
      per_page: 100,
    });

    // Analyze labels
    const allLabels = new Set<string>();
    const labelStats = new Map<string, number>();
    
    allPRs.forEach(pr => {
      pr.labels.forEach((label: any) => {
        allLabels.add(label.name);
        labelStats.set(label.name, (labelStats.get(label.name) || 0) + 1);
      });
    });

    // Find connector-related labels
    const connectorLabels = Array.from(allLabels).filter(label => 
      label.toLowerCase().includes('connector') || 
      label.toLowerCase().includes('integration')
    );

    // Filter PRs
    const exactMatchPRs = allPRs.filter(pr => 
      pr.labels.some((label: any) => label.name === 'A-connector-integration')
    );

    const flexibleMatchPRs = allPRs.filter(pr => 
      pr.labels.some((label: any) => 
        label.name.toLowerCase().includes('connector') || 
        label.name.toLowerCase().includes('integration')
      )
    );

    // Get rate limit info
    const rateLimit = await octokit.rest.rateLimit.get();

    const debugInfo = {
      timestamp: new Date().toISOString(),
      github_api: {
        total_prs_fetched: allPRs.length,
        rate_limit: {
          limit: rateLimit.data.rate.limit,
          remaining: rateLimit.data.rate.remaining,
          reset: new Date(rateLimit.data.rate.reset * 1000).toISOString(),
        }
      },
      labels: {
        total_unique_labels: allLabels.size,
        connector_related_labels: connectorLabels,
        top_10_labels: Array.from(labelStats.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([label, count]) => ({ label, count }))
      },
      filtering: {
        exact_match_filter: {
          criteria: 'label.name === "A-connector-integration"',
          matches: exactMatchPRs.length,
          prs: exactMatchPRs.map(pr => ({
            number: pr.number,
            title: pr.title,
            labels: pr.labels.map((l: any) => l.name)
          }))
        },
        flexible_match_filter: {
          criteria: 'label contains "connector" or "integration" (case-insensitive)',
          matches: flexibleMatchPRs.length,
          prs: flexibleMatchPRs.map(pr => ({
            number: pr.number,
            title: pr.title,
            labels: pr.labels.map((l: any) => l.name)
          }))
        }
      },
      current_dashboard: {
        stored_prs: pullRequests.length,
        stored_reviews: reviews.length,
        stored_comments: comments.length
      }
    };

    res.json(debugInfo);
  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch debug information', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// Webhook endpoint for GitHub events
app.post('/api/webhook', (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`Received GitHub webhook: ${event}`);

  // Handle different webhook events
  switch (event) {
    case 'pull_request':
      if (isConnectorIntegrationPR(payload.pull_request)) {
        fetchConnectorPRs(); // Refresh all PRs
      }
      break;
    case 'pull_request_review':
      if (payload.pull_request && isConnectorIntegrationPR(payload.pull_request)) {
        fetchPRReviews(payload.pull_request.number);
        fetchConnectorPRs(); // Refresh to update approval counts
      }
      break;
    case 'pull_request_review_comment':
      if (payload.pull_request && isConnectorIntegrationPR(payload.pull_request)) {
        fetchPRReviewComments(payload.pull_request.number);
      }
      break;
    case 'issue_comment':
      if (payload.issue?.pull_request && payload.issue.labels?.some((l: any) => l.name === 'A-connector-integration')) {
        fetchPRComments(payload.issue.number);
      }
      break;
  }

  res.status(200).send('OK');
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  
  // Send current data to new client
  ws.send(JSON.stringify({ type: 'initial_data', data: { pullRequests, reviews, comments } }));
  
  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
  });
});

// Initialize data on startup
async function initialize() {
  console.log('Initializing dashboard data...');
  await fetchConnectorPRs();
  console.log('Dashboard initialized successfully');
}

const PORT = process.env.PORT || 3001;

console.log(`🚀 Starting server on port ${PORT}`);
console.log(`📡 CORS enabled for development - allowing all origins`);
console.log(`🔗 API will be available at: http://localhost:${PORT}`);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initialize();
});

// Refresh data every 5 minutes
setInterval(fetchConnectorPRs, 5 * 60 * 1000);

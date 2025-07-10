import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import WebSocket from 'ws';
import http from 'http';
import geminiService, { PRSummary, CommonLearning } from './services/geminiService';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Security and middleware configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://frontend-plum-eta-85.vercel.app'] // Your actual Vercel frontend URL
    : ['http://localhost:3002', 'http://127.0.0.1:3002'],
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

// In-memory storage (replace with database in production)
let pullRequests: PullRequest[] = [];
let reviews: Review[] = [];
let comments: Comment[] = [];
let prSummaries: Map<number, PRSummary> = new Map(); // Store AI summaries by PR number
let commonLearning: CommonLearning | null = null; // Store common learning insights

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
    
    // Trigger background summary generation after PR data is updated
    setTimeout(() => {
      generateBackgroundSummaries().catch(error => {
        console.error('❌ Error in background summary generation:', error);
      });
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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initialize();
});

// Refresh data every 5 minutes
setInterval(fetchConnectorPRs, 5 * 60 * 1000);

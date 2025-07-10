import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Types for our summary structure
export interface PRSummary {
  summary: {
    executive: string;
    technical_feedback: TechnicalFeedback[];
    rl_insights: RLInsights;
    action_items: ActionItem[];
    sentiment_analysis: SentimentAnalysis;
  };
  metadata: {
    generated_at: string;
    model_used: string;
    token_usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    confidence_score: number;
    analysis_strategy?: {
      type: 'human_discussion' | 'code_only' | 'hybrid';
      human_comments: number;
      bot_comments: number;
      human_reviews: number;
      bot_reviews: number;
      confidence_level: 'high' | 'medium' | 'low';
    };
    background_generated?: boolean;
  };
}

export interface TechnicalFeedback {
  category: string;
  description: string;
  file_path?: string;
  line_number?: number;
  severity: 'high' | 'medium' | 'low';
  reviewer: string;
}

export interface RLInsights {
  current_approach_analysis: string;
  improvement_opportunities: string[];
  risk_assessment: string;
  recommended_experiments: string[];
}

export interface ActionItem {
  description: string;
  priority: 'high' | 'medium' | 'low';
  estimated_effort: string;
  blocking: boolean;
  assigned_to?: string;
}

export interface SentimentAnalysis {
  overall_tone: 'positive' | 'neutral' | 'negative';
  reviewer_confidence: 'high' | 'medium' | 'low';
  consensus_level: 'strong' | 'moderate' | 'weak';
}

// New interfaces for Common Learning
export interface TechnicalPattern {
  pattern_name: string;
  description: string;
  frequency: number;
  examples: string[];
  impact: 'high' | 'medium' | 'low';
  category: string;
}

export interface RLOptimization {
  optimization_type: string;
  description: string;
  implementation_approach: string;
  expected_benefits: string[];
  complexity: 'low' | 'medium' | 'high';
  priority: 'high' | 'medium' | 'low';
}

export interface BestPractice {
  practice_name: string;
  description: string;
  implementation_guide: string;
  benefits: string[];
  adoption_rate: number;
  category: string;
}

export interface PerformanceInsight {
  insight_type: string;
  description: string;
  performance_impact: string;
  implementation_effort: string;
  measurable_benefits: string[];
}

export interface SecurityPattern {
  pattern_name: string;
  description: string;
  security_level: 'critical' | 'high' | 'medium' | 'low';
  implementation_steps: string[];
  common_vulnerabilities_prevented: string[];
}

export interface TestingStrategy {
  strategy_name: string;
  description: string;
  test_types: string[];
  coverage_improvement: string;
  automation_potential: 'high' | 'medium' | 'low';
}

export interface CommonLearning {
  insights: {
    technical_patterns: TechnicalPattern[];
    rl_optimizations: RLOptimization[];
    best_practices: BestPractice[];
    performance_insights: PerformanceInsight[];
    security_patterns: SecurityPattern[];
    testing_strategies: TestingStrategy[];
  };
  trends: {
    emerging_topics: string[];
    declining_issues: string[];
    hot_discussions: string[];
    pattern_evolution: { [key: string]: number };
  };
  recommendations: {
    immediate_actions: string[];
    long_term_improvements: string[];
    experimental_approaches: string[];
    priority_focus_areas: string[];
  };
  metadata: {
    analyzed_prs: number;
    total_comments: number;
    total_reviews: number;
    last_updated: string;
    confidence_score: number;
    analysis_timeframe: string;
  };
}

// Comment and Review interfaces (matching the main app)
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
  file_path?: string | null;
  line_number?: number | null;
  diff_hunk?: string | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  // Enhanced code context
  code_context?: CodeContext | null;
}

interface Review {
  id: number;
  pr_id: number;
  reviewer_username: string;
  review_state: 'commented' | 'approved' | 'changes_requested';
  submitted_at: string;
  is_latest_review: boolean;
  content?: string;
}

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
  url: string;
}

class GeminiService {
  private model: any;

  constructor() {
    this.model = genAI.getGenerativeModel({ 
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp' 
    });
  }

  /**
   * Generate a comprehensive summary of PR comments and reviews
   */
  async generatePRSummary(
    pr: PullRequest,
    comments: Comment[],
    reviews: Review[]
  ): Promise<PRSummary> {
    try {
      const prompt = this.buildSummarizationPrompt(pr, comments, reviews);
      
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();

      // Clean up the response - remove markdown code blocks if present
      text = text.trim();
      if (text.startsWith('```json')) {
        text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (text.startsWith('```')) {
        text = text.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Parse the JSON response
      let summaryData;
      try {
        summaryData = JSON.parse(text);
      } catch (parseError) {
        console.error('Failed to parse Gemini response as JSON:', text);
        throw new Error(`Invalid JSON response from Gemini: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`);
      }

      // Add metadata
      const summary: PRSummary = {
        summary: summaryData,
        metadata: {
          generated_at: new Date().toISOString(),
          model_used: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp',
          token_usage: {
            prompt_tokens: result.response.usageMetadata?.promptTokenCount || 0,
            completion_tokens: result.response.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: result.response.usageMetadata?.totalTokenCount || 0,
          },
          confidence_score: this.calculateConfidenceScore(comments, reviews),
        },
      };

      return summary;
    } catch (error) {
      console.error('Error generating PR summary:', error);
      throw new Error(`Failed to generate summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build the prompt for Gemini AI
   */
  private buildSummarizationPrompt(
    pr: PullRequest,
    comments: Comment[],
    reviews: Review[]
  ): string {
    const commentsText = this.formatCommentsForPrompt(comments);
    const reviewsText = this.formatReviewsForPrompt(reviews);
    
    return `
You are an expert code reviewer and AI assistant specializing in analyzing GitHub Pull Request discussions. Your task is to generate a comprehensive summary of the PR conversation that will be used for reinforcement learning enhancement.

## PR Context:
- **Title**: ${pr.title}
- **Author**: ${pr.author}
- **Status**: ${pr.status}
- **Labels**: ${pr.labels.join(', ')}
- **Current Approvals**: ${pr.current_approvals_count}/5
- **Created**: ${pr.created_at}
- **URL**: ${pr.url}

## Reviews (${reviews.length} total):
${reviewsText}

## Comments (${comments.length} total):
${commentsText}

## Instructions:
Analyze all the above information and generate a structured JSON response with the following format. Focus on:
1. **Technical accuracy** - Identify specific code issues and suggestions
2. **RL Enhancement opportunities** - Look for patterns that could improve reinforcement learning systems
3. **Actionable insights** - Provide clear next steps and priorities
4. **Sentiment analysis** - Assess the overall tone and consensus

Return ONLY a valid JSON object with this exact structure:

{
  "executive": "Brief 2-3 sentence summary of the overall PR discussion and current state",
  "technical_feedback": [
    {
      "category": "Authentication|Performance|Security|Architecture|Testing|Documentation",
      "description": "Specific technical issue or suggestion",
      "file_path": "path/to/file.ts or null",
      "line_number": 123 or null,
      "severity": "high|medium|low",
      "reviewer": "username"
    }
  ],
  "rl_insights": {
    "current_approach_analysis": "Analysis of current RL approach if applicable",
    "improvement_opportunities": ["List of specific RL improvement suggestions"],
    "risk_assessment": "Assessment of risks in current implementation",
    "recommended_experiments": ["List of experiments to try"]
  },
  "action_items": [
    {
      "description": "Specific action needed",
      "priority": "high|medium|low",
      "estimated_effort": "1-2 hours|half day|1-2 days|1 week",
      "blocking": true or false,
      "assigned_to": "username or null"
    }
  ],
  "sentiment_analysis": {
    "overall_tone": "positive|neutral|negative",
    "reviewer_confidence": "high|medium|low",
    "consensus_level": "strong|moderate|weak"
  }
}

Important: 
- If there are no RL-specific discussions, still provide general RL insights based on the code changes
- Focus on connector integration patterns and their potential for RL enhancement
- Be specific and actionable in your recommendations
- Return only valid JSON, no additional text or formatting
`;
  }

  /**
   * Format comments for the prompt
   */
  private formatCommentsForPrompt(comments: Comment[]): string {
    if (comments.length === 0) {
      return "No comments available.";
    }

    return comments.map(comment => {
      let context = '';
      let codeBlock = '';
      
      if (comment.file_path) {
        context = `\n📁 File: ${comment.file_path}`;
        if (comment.line_number) {
          context += `:${comment.line_number}`;
        }
      }

      // Add code context if available
      if (comment.code_context) {
        const ctx = comment.code_context;
        codeBlock = `

Code Context (lines ${ctx.context_range}):
\`\`\`${ctx.language}
${ctx.code_snippet}
\`\`\``;
      }
      
      return `
**${comment.author}** (${comment.created_at}) - ${comment.comment_type}${context}${codeBlock}

Comment: ${comment.content}
---`;
    }).join('\n');
  }

  /**
   * Format reviews for the prompt
   */
  private formatReviewsForPrompt(reviews: Review[]): string {
    if (reviews.length === 0) {
      return "No reviews available.";
    }

    return reviews.map(review => {
      const stateEmoji = {
        'approved': '✅',
        'changes_requested': '❌',
        'commented': '💬'
      };

      return `
**${review.reviewer_username}** ${stateEmoji[review.review_state]} ${review.review_state.toUpperCase()} (${review.submitted_at})
${review.content || 'No review comment provided'}
---`;
    }).join('\n');
  }

  /**
   * Calculate confidence score based on available data
   */
  private calculateConfidenceScore(comments: Comment[], reviews: Review[]): number {
    let score = 0.5; // Base score

    // More comments and reviews = higher confidence
    const totalFeedback = comments.length + reviews.length;
    if (totalFeedback > 10) score += 0.3;
    else if (totalFeedback > 5) score += 0.2;
    else if (totalFeedback > 2) score += 0.1;

    // Code context comments = higher confidence
    const codeComments = comments.filter(c => c.file_path).length;
    if (codeComments > 0) score += 0.1;

    // Multiple reviewers = higher confidence
    const uniqueReviewers = new Set(reviews.map(r => r.reviewer_username)).size;
    if (uniqueReviewers > 3) score += 0.1;
    else if (uniqueReviewers > 1) score += 0.05;

    return Math.min(score, 1.0);
  }

  /**
   * Generate common learning insights from all PRs
   */
  async generateCommonLearning(
    allPRs: PullRequest[],
    allComments: Comment[],
    allReviews: Review[]
  ): Promise<CommonLearning> {
    try {
      const prompt = this.buildCommonLearningPrompt(allPRs, allComments, allReviews);
      
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();

      // Clean up the response
      text = text.trim();
      if (text.startsWith('```json')) {
        text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (text.startsWith('```')) {
        text = text.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Parse the JSON response
      let learningData;
      try {
        learningData = JSON.parse(text);
      } catch (parseError) {
        console.error('Failed to parse Common Learning response as JSON:', text);
        throw new Error(`Invalid JSON response from Gemini: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`);
      }

      // Add metadata
      const commonLearning: CommonLearning = {
        insights: learningData.insights,
        trends: learningData.trends,
        recommendations: learningData.recommendations,
        metadata: {
          analyzed_prs: allPRs.length,
          total_comments: allComments.length,
          total_reviews: allReviews.length,
          last_updated: new Date().toISOString(),
          confidence_score: this.calculateCommonLearningConfidence(allPRs, allComments, allReviews),
          analysis_timeframe: this.getAnalysisTimeframe(allPRs),
        },
      };

      return commonLearning;
    } catch (error) {
      console.error('Error generating common learning:', error);
      throw new Error(`Failed to generate common learning: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build the prompt for Common Learning analysis
   */
  private buildCommonLearningPrompt(
    allPRs: PullRequest[],
    allComments: Comment[],
    allReviews: Review[]
  ): string {
    // Group data by categories for analysis
    const prsByStatus = this.groupPRsByStatus(allPRs);
    const commentsByType = this.groupCommentsByType(allComments);
    const reviewsByState = this.groupReviewsByState(allReviews);
    
    // Get recent trends
    const recentPRs = allPRs.filter(pr => {
      const prDate = new Date(pr.created_at);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return prDate >= thirtyDaysAgo;
    });

    return `
You are an expert AI system specializing in analyzing software development patterns and reinforcement learning optimization. Your task is to analyze ALL pull request discussions from the HyperSwitch connector integration repository to extract common learning patterns, insights, and recommendations.

## Repository Analysis Overview:
- **Total PRs Analyzed**: ${allPRs.length}
- **Total Comments**: ${allComments.length}
- **Total Reviews**: ${allReviews.length}
- **Recent PRs (30 days)**: ${recentPRs.length}

## PR Status Distribution:
- Open: ${prsByStatus.open.length}
- Merged/Closed: ${prsByStatus.closed.length}

## Comment Types:
- Review Comments: ${commentsByType.review.length}
- General Comments: ${commentsByType.general.length}
- Issue Comments: ${commentsByType.issue.length}

## Review States:
- Approved: ${reviewsByState.approved.length}
- Changes Requested: ${reviewsByState.changes_requested.length}
- Commented: ${reviewsByState.commented.length}

## Sample Recent PR Titles (for context):
${recentPRs.slice(0, 10).map(pr => `- ${pr.title}`).join('\n')}

## Analysis Instructions:
Analyze all the data to identify patterns, common issues, best practices, and learning opportunities. Focus on:

1. **Technical Patterns**: Recurring code issues, solutions, and architectural patterns
2. **RL Optimizations**: Reinforcement learning improvement opportunities
3. **Best Practices**: Proven approaches that lead to successful integrations
4. **Performance Insights**: Speed, efficiency, and optimization learnings
5. **Security Patterns**: Security-related learnings and common vulnerabilities
6. **Testing Strategies**: Effective testing approaches and coverage improvements

Return ONLY a valid JSON object with this exact structure:

{
  "insights": {
    "technical_patterns": [
      {
        "pattern_name": "Clear, descriptive name",
        "description": "Detailed description of the pattern",
        "frequency": 85,
        "examples": ["Example 1", "Example 2"],
        "impact": "high|medium|low",
        "category": "Authentication|Performance|Security|Architecture|Testing|Documentation"
      }
    ],
    "rl_optimizations": [
      {
        "optimization_type": "Type of RL optimization",
        "description": "Detailed description",
        "implementation_approach": "How to implement",
        "expected_benefits": ["Benefit 1", "Benefit 2"],
        "complexity": "low|medium|high",
        "priority": "high|medium|low"
      }
    ],
    "best_practices": [
      {
        "practice_name": "Name of best practice",
        "description": "What the practice involves",
        "implementation_guide": "Step-by-step guide",
        "benefits": ["Benefit 1", "Benefit 2"],
        "adoption_rate": 75,
        "category": "Development|Testing|Security|Performance|Documentation"
      }
    ],
    "performance_insights": [
      {
        "insight_type": "Type of performance insight",
        "description": "Detailed description",
        "performance_impact": "Quantified impact description",
        "implementation_effort": "Effort required",
        "measurable_benefits": ["Measurable benefit 1", "Measurable benefit 2"]
      }
    ],
    "security_patterns": [
      {
        "pattern_name": "Security pattern name",
        "description": "What the pattern addresses",
        "security_level": "critical|high|medium|low",
        "implementation_steps": ["Step 1", "Step 2"],
        "common_vulnerabilities_prevented": ["Vulnerability 1", "Vulnerability 2"]
      }
    ],
    "testing_strategies": [
      {
        "strategy_name": "Testing strategy name",
        "description": "What the strategy involves",
        "test_types": ["Unit", "Integration", "E2E"],
        "coverage_improvement": "Percentage or description",
        "automation_potential": "high|medium|low"
      }
    ]
  },
  "trends": {
    "emerging_topics": ["Topic 1", "Topic 2", "Topic 3"],
    "declining_issues": ["Issue 1", "Issue 2"],
    "hot_discussions": ["Discussion topic 1", "Discussion topic 2"],
    "pattern_evolution": {
      "Authentication": 25,
      "Performance": 40,
      "Security": 15,
      "Testing": 20
    }
  },
  "recommendations": {
    "immediate_actions": ["Action 1", "Action 2"],
    "long_term_improvements": ["Improvement 1", "Improvement 2"],
    "experimental_approaches": ["Experiment 1", "Experiment 2"],
    "priority_focus_areas": ["Area 1", "Area 2"]
  }
}

Important Guidelines:
- Base insights on actual patterns from the data
- Provide actionable, specific recommendations
- Focus on connector integration patterns and RL enhancement opportunities
- Include quantitative metrics where possible (frequencies, adoption rates, etc.)
- Prioritize insights that can improve development velocity and code quality
- Return only valid JSON, no additional text or formatting
`;
  }

  /**
   * Helper methods for data grouping and analysis
   */
  private groupPRsByStatus(prs: PullRequest[]) {
    return {
      open: prs.filter(pr => pr.status === 'open'),
      closed: prs.filter(pr => pr.status === 'merged' || pr.status === 'closed')
    };
  }

  private groupCommentsByType(comments: Comment[]) {
    return {
      review: comments.filter(c => c.comment_type === 'review'),
      general: comments.filter(c => c.comment_type === 'general'),
      issue: comments.filter(c => c.comment_type === 'issue')
    };
  }

  private groupReviewsByState(reviews: Review[]) {
    return {
      approved: reviews.filter(r => r.review_state === 'approved'),
      changes_requested: reviews.filter(r => r.review_state === 'changes_requested'),
      commented: reviews.filter(r => r.review_state === 'commented')
    };
  }

  private getAnalysisTimeframe(prs: PullRequest[]): string {
    if (prs.length === 0) return 'No data';
    
    const dates = prs.map(pr => new Date(pr.created_at)).sort((a, b) => a.getTime() - b.getTime());
    const earliest = dates[0];
    const latest = dates[dates.length - 1];
    
    return `${earliest.toISOString().split('T')[0]} to ${latest.toISOString().split('T')[0]}`;
  }

  private calculateCommonLearningConfidence(
    prs: PullRequest[],
    comments: Comment[],
    reviews: Review[]
  ): number {
    let score = 0.3; // Base score

    // More data = higher confidence
    const totalData = prs.length + comments.length + reviews.length;
    if (totalData > 1000) score += 0.4;
    else if (totalData > 500) score += 0.3;
    else if (totalData > 100) score += 0.2;
    else if (totalData > 50) score += 0.1;

    // Diverse data types = higher confidence
    if (comments.length > 0 && reviews.length > 0) score += 0.1;

    // Recent data = higher confidence
    const recentPRs = prs.filter(pr => {
      const prDate = new Date(pr.created_at);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return prDate >= thirtyDaysAgo;
    });
    
    if (recentPRs.length > 10) score += 0.2;
    else if (recentPRs.length > 5) score += 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Test the Gemini connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.model.generateContent("Hello, please respond with 'OK' if you can receive this message.");
      const response = await result.response;
      const text = response.text();
      return text.toLowerCase().includes('ok');
    } catch (error) {
      console.error('Gemini connection test failed:', error);
      return false;
    }
  }
}

export default new GeminiService();

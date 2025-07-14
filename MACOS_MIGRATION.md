# macOS App Migration Guide
## Connector PR Dashboard - React to SwiftUI Migration

### 📋 Overview

This document provides a comprehensive guide for migrating the Connector PR Dashboard from a React TypeScript web application to a native macOS SwiftUI application. The migration will maintain all core functionality while leveraging native macOS capabilities for better performance and user experience.

---

## 🎯 Migration Scope

### ✅ What Will Be Migrated
- **Dashboard Tab**: Analytics overview with metrics and charts
- **Pull Requests Tab**: PR list with search, filtering, and detail views
- **Real-time Updates**: WebSocket integration for live data
- **Core API Integration**: All existing backend endpoints
- **Data Models**: PR, Review, Comment, Analytics structures

### ❌ What Will Be Removed
- **Common Learning Tab**: AI-powered insights (Gemini integration)
- **AI Summary Generation**: Background summary processing
- **Complex Caching**: Simplified to basic in-memory caching
- **Web-specific Features**: Browser-dependent functionality

---

## 🏗️ Architecture Overview

### Current React Architecture
```
React Frontend (Port 3000)
├── App.tsx (Router + Navigation)
├── Dashboard.tsx (Analytics + Quick Stats)
├── PullRequestsTab.tsx (PR List)
├── PRCard.tsx (Individual PR Display)
├── Analytics.tsx (Charts + Metrics)
└── API Integration (Axios + React Query)
```

### Target macOS Architecture
```
SwiftUI macOS App
├── ConnectorPRDashboardApp.swift (App Entry Point)
├── ContentView.swift (Tab Navigation)
├── Views/
│   ├── DashboardView.swift
│   ├── PullRequestsView.swift
│   ├── PRDetailView.swift
│   └── Components/
├── ViewModels/ (MVVM Pattern)
├── Models/ (Data Structures)
└── Services/ (API + WebSocket)
```

---

## 📊 Data Models Migration

### 1. PullRequest Model

**React TypeScript:**
```typescript
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
```

**SwiftUI Swift:**
```swift
struct PullRequest: Codable, Identifiable {
    let id: Int
    let githubPRNumber: Int
    let title: String
    let author: String
    let createdAt: Date
    let updatedAt: Date
    let mergedAt: Date?
    let status: PRStatus
    let isConnectorIntegration: Bool
    let currentApprovalsCount: Int
    let labels: [String]
    let reviewers: [String]
    let requestedReviewers: [String]
    let pendingReviewers: [String]
    let url: URL
    
    enum CodingKeys: String, CodingKey {
        case id, title, author, labels, reviewers, url
        case githubPRNumber = "github_pr_number"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case mergedAt = "merged_at"
        case status
        case isConnectorIntegration = "is_connector_integration"
        case currentApprovalsCount = "current_approvals_count"
        case requestedReviewers = "requested_reviewers"
        case pendingReviewers = "pending_reviewers"
    }
}

enum PRStatus: String, Codable, CaseIterable {
    case open, merged, closed
    
    var displayName: String {
        switch self {
        case .open: return "Open"
        case .merged: return "Merged"
        case .closed: return "Closed"
        }
    }
    
    var color: Color {
        switch self {
        case .open: return .blue
        case .merged: return .green
        case .closed: return .gray
        }
    }
}
```

### 2. Review Model

**React TypeScript:**
```typescript
interface Review {
  id: number;
  pr_id: number;
  reviewer_username: string;
  review_state: 'commented' | 'approved' | 'changes_requested';
  submitted_at: string;
  is_latest_review: boolean;
}
```

**SwiftUI Swift:**
```swift
struct Review: Codable, Identifiable {
    let id: Int
    let prId: Int
    let reviewerUsername: String
    let reviewState: ReviewState
    let submittedAt: Date
    let isLatestReview: Bool
    
    enum CodingKeys: String, CodingKey {
        case id
        case prId = "pr_id"
        case reviewerUsername = "reviewer_username"
        case reviewState = "review_state"
        case submittedAt = "submitted_at"
        case isLatestReview = "is_latest_review"
    }
}

enum ReviewState: String, Codable, CaseIterable {
    case commented, approved, changesRequested = "changes_requested"
    
    var displayName: String {
        switch self {
        case .commented: return "Commented"
        case .approved: return "Approved"
        case .changesRequested: return "Changes Requested"
        }
    }
    
    var color: Color {
        switch self {
        case .commented: return .blue
        case .approved: return .green
        case .changesRequested: return .orange
        }
    }
    
    var icon: String {
        switch self {
        case .commented: return "message"
        case .approved: return "checkmark.circle"
        case .changesRequested: return "exclamationmark.triangle"
        }
    }
}
```

### 3. Analytics Model

**React TypeScript:**
```typescript
// Calculated in component
const stats = {
  total: prs.length,
  open: prs.filter(pr => pr.status === 'open').length,
  merged: prs.filter(pr => pr.status === 'merged').length,
  needingReview: prs.filter(pr => pr.current_approvals_count === 0).length,
  readyToMerge: prs.filter(pr => pr.pending_reviewers.length === 0).length,
  changesRequested: prs.filter(pr => /* complex logic */).length
};
```

**SwiftUI Swift:**
```swift
struct Analytics: Codable {
    let totalPRs: Int
    let openPRs: Int
    let mergedPRs: Int
    let needingReview: Int
    let readyToMerge: Int
    let changesRequested: Int
    let averageApprovals: Double
    
    enum CodingKeys: String, CodingKey {
        case totalPRs = "total_prs"
        case openPRs = "open_prs"
        case mergedPRs = "merged_prs"
        case needingReview = "needing_review"
        case readyToMerge = "ready_to_merge"
        case changesRequested = "changes_requested"
        case averageApprovals = "average_approvals"
    }
}

// Computed analytics from PR data
extension Array where Element == PullRequest {
    var analytics: Analytics {
        let total = count
        let open = filter { $0.status == .open }.count
        let merged = filter { $0.status == .merged || $0.status == .closed }.count
        let needingReview = filter { $0.currentApprovalsCount == 0 }.count
        let readyToMerge = filter { $0.pendingReviewers.isEmpty && $0.currentApprovalsCount > 0 }.count
        let avgApprovals = isEmpty ? 0.0 : Double(map(\.currentApprovalsCount).reduce(0, +)) / Double(count)
        
        return Analytics(
            totalPRs: total,
            openPRs: open,
            mergedPRs: merged,
            needingReview: needingReview,
            readyToMerge: readyToMerge,
            changesRequested: 0, // Calculate based on reviews
            averageApprovals: avgApprovals
        )
    }
}
```

---

## 🌐 API Service Migration

### Current React API Integration

**React with Axios + React Query:**
```typescript
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

// Fetch PRs
const { data: prs = [], isLoading, refetch } = useQuery<PullRequest[]>({
  queryKey: ['prs'],
  queryFn: async () => {
    const response = await axios.get(`${API_BASE_URL}/api/prs`);
    return response.data;
  },
  refetchInterval: 30000,
});

// Fetch reviews
const { data: allReviews = [] } = useQuery<Review[]>({
  queryKey: ['reviews'],
  queryFn: async () => {
    const reviewPromises = prs.map(pr =>
      axios.get(`${API_BASE_URL}/api/prs/${pr.github_pr_number}/reviews`)
    );
    const responses = await Promise.all(reviewPromises);
    return responses.flatMap(response => response.data);
  },
  enabled: prs.length > 0,
});
```

### SwiftUI API Service

**APIService.swift:**
```swift
import Foundation
import Combine

@MainActor
class APIService: ObservableObject {
    private let baseURL = "http://localhost:3001"
    private let session = URLSession.shared
    private let decoder: JSONDecoder
    
    init() {
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }
    
    // MARK: - Pull Requests
    
    func fetchPRs() async throws -> [PullRequest] {
        let url = URL(string: "\(baseURL)/api/prs")!
        let (data, _) = try await session.data(from: url)
        return try decoder.decode([PullRequest].self, from: data)
    }
    
    func fetchReviews(for prNumber: Int) async throws -> [Review] {
        let url = URL(string: "\(baseURL)/api/prs/\(prNumber)/reviews")!
        let (data, _) = try await session.data(from: url)
        return try decoder.decode([Review].self, from: data)
    }
    
    func fetchAllReviews(for prs: [PullRequest]) async throws -> [Review] {
        let reviews = try await withThrowingTaskGroup(of: [Review].self) { group in
            for pr in prs {
                group.addTask {
                    try await self.fetchReviews(for: pr.githubPRNumber)
                }
            }
            
            var allReviews: [Review] = []
            for try await reviews in group {
                allReviews.append(contentsOf: reviews)
            }
            return allReviews
        }
        return reviews
    }
    
    func fetchComments(for prNumber: Int) async throws -> [Comment] {
        let url = URL(string: "\(baseURL)/api/prs/\(prNumber)/comments")!
        let (data, _) = try await session.data(from: url)
        return try decoder.decode([Comment].self, from: data)
    }
    
    // MARK: - Analytics
    
    func fetchAnalytics() async throws -> Analytics {
        let url = URL(string: "\(baseURL)/api/analytics")!
        let (data, _) = try await session.data(from: url)
        return try decoder.decode(Analytics.self, from: data)
    }
}

// MARK: - Error Handling

enum APIError: LocalizedError {
    case invalidURL
    case noData
    case decodingError(Error)
    case networkError(Error)
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .noData:
            return "No data received"
        case .decodingError(let error):
            return "Failed to decode data: \(error.localizedDescription)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}
```

---

## 🔌 WebSocket Integration

### Current React WebSocket

**React Implementation:**
```typescript
useEffect(() => {
  const wsUrl = API_BASE_URL.replace('http', 'ws');
  const websocket = new WebSocket(wsUrl);

  websocket.onopen = () => {
    console.log('Connected to WebSocket');
    setWs(websocket);
  };

  websocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'prs_updated') {
      refetch();
    }
  };

  return () => websocket.close();
}, [refetch]);
```

### SwiftUI WebSocket Service

**WebSocketService.swift:**
```swift
import Foundation
import Combine

@MainActor
class WebSocketService: ObservableObject {
    @Published var isConnected = false
    @Published var lastUpdate: Date?
    
    private var webSocketTask: URLSessionWebSocketTask?
    private let url = URL(string: "ws://localhost:3001")!
    
    func connect() {
        disconnect() // Ensure clean state
        
        webSocketTask = URLSession.shared.webSocketTask(with: url)
        webSocketTask?.resume()
        
        isConnected = true
        receiveMessage()
    }
    
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isConnected = false
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                DispatchQueue.main.async {
                    self?.handleMessage(message)
                    self?.receiveMessage() // Continue listening
                }
            case .failure(let error):
                DispatchQueue.main.async {
                    print("WebSocket error: \(error)")
                    self?.isConnected = false
                }
            }
        }
    }
    
    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            if let data = text.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let type = json["type"] as? String {
                
                switch type {
                case "prs_updated":
                    lastUpdate = Date()
                    NotificationCenter.default.post(name: .prsUpdated, object: nil)
                case "summary_generated":
                    NotificationCenter.default.post(name: .summaryGenerated, object: json["data"])
                default:
                    break
                }
            }
        case .data(let data):
            print("Received binary data: \(data)")
        @unknown default:
            break
        }
    }
}

// MARK: - Notification Names
extension Notification.Name {
    static let prsUpdated = Notification.Name("prsUpdated")
    static let summaryGenerated = Notification.Name("summaryGenerated")
}
```

---

## 🎨 UI Component Migration

### 1. Dashboard View

**React Dashboard Component:**
```typescript
const Dashboard: React.FC = () => {
  const { data: prs = [], isLoading, refetch } = useQuery<PullRequest[]>({
    queryKey: ['prs'],
    queryFn: async () => {
      const response = await axios.get(`${API_BASE_URL}/api/prs`);
      return response.data;
    },
    refetchInterval: 30000,
  });

  const stats = React.useMemo(() => {
    const total = prs.length;
    const open = prs.filter(pr => pr.status === 'open').length;
    // ... more calculations
    return { total, open, merged, needingReview, readyToMerge, changesRequested };
  }, [prs, allReviews]);

  return (
    <div className="min-h-screen bg-gradient-dashboard">
      {/* Header Section */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">Overview of connector integration pull requests</p>
      </div>

      {/* Quick Stats Overview */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6 mb-8">
        {/* Metric cards */}
      </div>

      {/* Analytics Section */}
      <Analytics prs={prs} reviews={allReviews} />
    </div>
  );
};
```

**SwiftUI Dashboard View:**
```swift
struct DashboardView: View {
    @StateObject private var viewModel = DashboardViewModel()
    @StateObject private var webSocketService = WebSocketService()
    
    var body: some View {
        NavigationView {
            ScrollView {
                LazyVStack(spacing: 20) {
                    // Header Section
                    headerSection
                    
                    // Quick Stats Grid
                    metricsGrid
                    
                    // Analytics Charts
                    analyticsSection
                    
                    // Recent Activity
                    recentActivitySection
                }
                .padding()
            }
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    HStack {
                        connectionStatus
                        refreshButton
                    }
                }
            }
        }
        .task {
            await viewModel.loadData()
            webSocketService.connect()
        }
        .onReceive(NotificationCenter.default.publisher(for: .prsUpdated)) { _ in
            Task {
                await viewModel.loadData()
            }
        }
    }
    
    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Dashboard")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    
                    Text("Overview of connector integration pull requests and system analytics")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
        }
    }
    
    private var metricsGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
            MetricCard(
                title: "Total PRs",
                value: "\(viewModel.analytics.totalPRs)",
                icon: "folder",
                color: .blue
            )
            
            MetricCard(
                title: "Open",
                value: "\(viewModel.analytics.openPRs)",
                icon: "clock",
                color: .green
            )
            
            MetricCard(
                title: "Merged",
                value: "\(viewModel.analytics.mergedPRs)",
                icon: "checkmark.circle",
                color: .purple
            )
            
            MetricCard(
                title: "Needs Review",
                value: "\(viewModel.analytics.needingReview)",
                icon: "person.2",
                color: .orange
            )
            
            MetricCard(
                title: "Ready to Merge",
                value: "\(viewModel.analytics.readyToMerge)",
                icon: "checkmark.circle.fill",
                color: .green
            )
            
            MetricCard(
                title: "Changes Requested",
                value: "\(viewModel.analytics.changesRequested)",
                icon: "exclamationmark.triangle",
                color: .red
            )
        }
    }
    
    private var connectionStatus: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(webSocketService.isConnected ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            
            Text(webSocketService.isConnected ? "Live" : "Offline")
                .font(.caption)
                .fontWeight(.medium)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.secondary.opacity(0.1))
        .cornerRadius(8)
    }
    
    private var refreshButton: some View {
        Button(action: {
            Task {
                await viewModel.loadData()
            }
        }) {
            Image(systemName: "arrow.clockwise")
                .foregroundColor(.primary)
        }
        .disabled(viewModel.isLoading)
    }
}

// MARK: - Metric Card Component
struct MetricCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .foregroundColor(.white)
                    .frame(width: 32, height: 32)
                    .background(color.gradient)
                    .cornerRadius(8)
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.secondary)
                    
                    Text("Live data")
                        .font(.caption2)
                        .foregroundColor(.tertiary)
                }
                
                Spacer()
            }
            
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(color)
        }
        .padding()
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.05), radius: 2, x: 0, y: 1)
    }
}
```

### 2. Pull Requests View

**React PullRequestsTab:**
```typescript
const PullRequestsTab: React.FC = () => {
  const { data: prs = [], isLoading, error, refetch } = useQuery<PullRequest[]>({
    queryKey: ['prs'],
    queryFn: async () => {
      const response = await axios.get(`${API_BASE_URL}/api/prs`);
      return response.data;
    },
    refetchInterval: 30000,
  });

  return (
    <div className="min-h-screen bg-gradient-dashboard">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {prs.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {prs.map((pr) => (
              <PRCard 
                key={pr.id} 
                pr={pr} 
                reviews={getReviewsForPR(pr.github_pr_number)}
                statusColor={getStatusColor(pr, reviews)}
                onClick={() => navigate(`/pr/${pr.github_pr_number}`)}
              />
            ))}
          </div>
        ) : (
          <div>No Pull Requests</div>
        )}
      </div>
    </div>
  );
};
```

**SwiftUI PullRequestsView:**
```swift
struct PullRequestsView: View {
    @StateObject private var viewModel = PullRequestsViewModel()
    @State private var searchText = ""
    @State private var selectedStatus: PRStatus? = nil
    
    var filteredPRs: [PullRequest] {
        var prs = viewModel.prs
        
        if !searchText.isEmpty {
            prs = prs.filter { pr in
                pr.title.localizedCaseInsensitiveContains(searchText) ||
                pr.author.localizedCaseInsensitiveContains(searchText)
            }
        }
        
        if let status = selectedStatus {
            prs = prs.filter { $0.status == status }
        }
        
        return prs
    }
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Search and Filter Bar
                searchAndFilterBar
                
                // PR List
                if viewModel.isLoading {
                    loadingView
                } else if filteredPRs.isEmpty {
                    emptyStateView
                } else {
                    prListView
                }
            }
            .navigationTitle("Pull Requests")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Refresh") {
                        Task {
                            await viewModel.loadData()
                        }
                    }
                }
            }
        }
        .task {
            await viewModel.loadData()
        }
        .refreshable {
            await viewModel.loadData()
        }
    }
    
    private var searchAndFilterBar: some View {
        VStack(spacing: 12) {
            // Search Bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                
                TextField("Search PRs...", text: $searchText)
                    .textFieldStyle(.plain)
                
                if !searchText.isEmpty {
                    Button("Clear") {
                        searchText = ""
                    }
                    .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(NSColor.controlBackgroundColor))
            .cornerRadius(8)
            
            // Status Filter
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    FilterChip(
                        title: "All",
                        isSelected: selectedStatus == nil,
                        action: { selectedStatus = nil }
                    )
                    
                    ForEach(PRStatus.allCases, id: \.self) { status in
                        FilterChip(
                            title: status.displayName,
                            isSelected: selectedStatus == status,
                            action: { selectedStatus = status }
                        )
                    }
                }
                .padding(.horizontal)
            }
        }
        .padding()
        .background(Color(NSColor.windowBackgroundColor))
    }
    
    private var prListView: some View {
        ScrollView {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: 16) {
                ForEach(filteredPRs) { pr in
                    NavigationLink(destination: PRDetailView(pr: pr)) {
                        PRCardView(pr: pr, reviews: viewModel.getReviews(for: pr.githubPRNumber))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding()
        }
    }
    
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            
            Text("Loading Pull Requests...")
                .font(.headline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            
            Text("No Pull Requests")
                .font(.headline)
            
            Text("No connector integration pull requests match your criteria.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

// MARK: - Filter Chip Component
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption)
                .fontWeight(.medium)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? Color.accentColor : Color(NSColor.controlBackgroundColor))
                .foregroundColor(isSelected ? .white : .primary)
                .cornerRadius(16)
        }
        .buttonStyle(.plain)
    }
}
```

### 3. PR Card Component

**React PRCard:**
```typescript
const PRCard: React.FC<PRCardProps> = ({ pr, reviews, statusColor, onClick }) => {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
    
    if (diffInHours < 24) {
      return `${diffInHours}h ago`;
    } else {
      const diffInDays = Math.floor(diffInHours / 24);
      return `${diffInDays}d ago`;
    }
  };

  return (
    <div className="card group cursor-pointer" onClick={onClick}>
      {/* Status Color Bar */}
      <div className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl ${statusColorClass}`}></div>
      
      {/* Card Content */}
      <div className="p-6 pb-4">
        <h3 className="text-lg font-semibold text-gray-900">{pr.title}</h3>
        <div className="flex items-center space-x-3 text-sm text-gray-500">
          <span>#{pr.github_pr_number}</span>
          <span>by {pr.author}</span>
          <span>Created {formatDate(pr.created_at)}</span>
        </div>
      </div>
    </div>
  );
};
```

**SwiftUI PRCardView:**
```swift
struct PRCardView: View {
    let pr: PullRequest
    let reviews: [Review]
    
    private var statusColor: Color {
        switch pr.status {
        case .open:
            if pr.pendingReviewers.isEmpty && pr.currentApprovalsCount > 0 {
                return .green
            } else if pr.currentApprovalsCount == 0 {
                return .orange
            } else {
                return .blue
            }
        case .merged, .closed:
            return .green
        }
    }
    
    private var statusText: String {
        switch pr.status {
        case .open:
            if pr.pendingReviewers.isEmpty && pr.currentApprovalsCount > 0 {
                return "Ready to merge"
            } else if pr.currentApprovalsCount == 0 {
                return "Needs review"
            } else {
                return "\(pr.currentApprovalsCount) approvals"
            }
        case .merged, .closed:
            return "Merged"
        }
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Status Color Bar
            Rectangle()
                .fill(statusColor.gradient)
                .frame(height: 3)
            
            VStack(alignment: .leading, spacing: 12) {
                // Header
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("#\(pr.githubPRNumber)")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.1))
                                .cornerRadius(4)
                            
                            Spacer()
                        }
                        
                        Text(pr.title)
                            .font(.headline)
                            .fontWeight(.semibold)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    
                    Spacer()
                }
                
                // Author and Date
                HStack(spacing: 12) {
                    Label(pr.author, systemImage: "person")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    Label(pr.createdAt.timeAgoDisplay(), systemImage: "clock")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                
                // Status Badge
                HStack {
                    Label(statusText, systemImage: statusIcon)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(statusColor)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(statusColor.opacity(0.1))
                        .cornerRadius(8)
                    
                    Spacer()
                    
                    // Approval Progress
                    if pr.currentApprovalsCount > 0 {
                        Text("\(pr.currentApprovalsCount) approvals")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                
                // Labels (if any)
                if !pr.labels.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(pr.labels.prefix(3), id: \.self) { label in
                                Text(label)
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.blue.opacity(0.1))
                                    .foregroundColor(.blue)
                                    .cornerRadius(4)
                            }
                            
                            if pr.labels.count > 3 {
                                Text("+\(pr.labels.count - 3)")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
            .padding()
        }
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.05), radius: 2, x: 0, y: 1)
    }
    
    private var statusIcon: String {
        switch pr.status {
        case .open:
            if pr.pendingReviewers.isEmpty && pr.currentApprovalsCount > 0 {
                return "checkmark.circle.fill"
            } else if pr.currentApprovalsCount == 0 {
                return "clock"
            } else {
                return "ellipsis.circle"
            }
        case .merged, .closed:
            return "checkmark.circle.fill"
        }
    }
}

// MARK: - Date Extension
extension Date {
    func timeAgoDisplay() -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}
```

---

## 🧠 ViewModels (MVVM Pattern)

### DashboardViewModel

```swift
@MainActor
class DashboardViewModel: ObservableObject {
    @Published var prs: [PullRequest] = []
    @Published var reviews: [Review] = []
    @Published var analytics: Analytics = Analytics(
        totalPRs: 0, openPRs: 0, mergedPRs: 0,
        needingReview: 0, readyToMerge: 0,
        changesRequested: 0, averageApprovals: 0.0
    )
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let apiService = APIService()
    
    func loadData() async {
        isLoading = true
        errorMessage = nil
        
        do {
            // Fetch PRs
            prs = try await apiService.fetchPRs()
            
            // Fetch all reviews
            reviews = try await apiService.fetchAllReviews(for: prs)
            
            // Calculate analytics
            analytics = calculateAnalytics()
            
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    private func calculateAnalytics() -> Analytics {
        let total = prs.count
        let open = prs.filter { $0.status == .open }.count
        let merged = prs.filter { $0.status == .merged || $0.status == .closed }.count
        let needingReview = prs.filter { $0.currentApprovalsCount == 0 }.count
        let readyToMerge = prs.filter { $0.pendingReviewers.isEmpty && $0.currentApprovalsCount > 0 }.count
        
        // Calculate changes requested
        let changesRequested = prs.filter { pr in
            let prReviews = reviews.filter { $0.prId == pr.githubPRNumber }
            return prReviews.contains { $0.reviewState == .changesRequested }
        }.count
        
        let avgApprovals = total > 0 ? Double(prs.map(\.currentApprovalsCount).reduce(0, +)) / Double(total) : 0.0
        
        return Analytics(
            totalPRs: total,
            openPRs: open,
            mergedPRs: merged,
            needingReview: needingReview,
            readyToMerge: readyToMerge,
            changesRequested: changesRequested,
            averageApprovals: avgApprovals
        )
    }
    
    var recentPRs: [PullRequest] {
        return prs
            .filter { $0.status == .open }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(5)
            .map { $0 }
    }
}
```

### PullRequestsViewModel

```swift
@MainActor
class PullRequestsViewModel: ObservableObject {
    @Published var prs: [PullRequest] = []
    @Published var reviews: [Review] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let apiService = APIService()
    
    func loadData() async {
        isLoading = true
        errorMessage = nil
        
        do {
            prs = try await apiService.fetchPRs()
            reviews = try await apiService.fetchAllReviews(for: prs)
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    func getReviews(for prNumber: Int) -> [Review] {
        return reviews.filter { $0.prId == prNumber }
    }
}
```

---

## 🏗️ Backend Simplification

### Remove AI Components

**Files to Remove:**
- `backend/src/services/geminiService.ts`

**Endpoints to Remove:**
```typescript
// Remove these endpoints from index.ts
app.get('/api/prs/:prNumber/summary', ...)
app.post('/api/prs/:prNumber/summary/regenerate', ...)
app.get('/api/prs/:prNumber/summary/status', ...)
app.get('/api/summaries/status', ...)
app.get('/api/common-learning', ...)
app.post('/api/common-learning/regenerate', ...)
app.get('/api/common-learning/status', ...)
app.get('/api/common-learning/trends', ...)
app.get('/api/gemini/test', ...)
```

**Variables to Remove:**
```typescript
// Remove from index.ts
let prSummaries: Map<number, PRSummary> = new Map();
let commonLearning: CommonLearning | null = null;

// Remove background generation function
async function generateBackgroundSummaries() { ... }
```

### Simplified Backend Structure

**Keep These Endpoints:**
```typescript
// Core endpoints for macOS app
app.get('/api/prs', ...)                    // List all PRs
app.get('/api/prs/:prNumber/reviews', ...)  // PR reviews
app.get('/api/prs/:prNumber/comments', ...) // PR comments
app.get('/api/analytics', ...)              // Dashboard analytics
app.post('/api/webhook', ...)               // GitHub webhooks
app.get('/api/debug', ...)                  // Debug info
```

**Simplified Analytics Endpoint:**
```typescript
app.get('/api/analytics', (req, res) => {
  const analytics = {
    totalPRs: pullRequests.length,
    openPRs: pullRequests.filter(pr => pr.status === 'open').length,
    mergedPRs: pullRequests.filter(pr => pr.status === 'merged' || pr.status === 'closed').length,
    needingReview: pullRequests.filter(pr => pr.current_approvals_count === 0).length,
    readyToMerge: pullRequests.filter(pr => 
      pr.pending_reviewers.length === 0 && pr.current_approvals_count > 0
    ).length,
    changesRequested: pullRequests.filter(pr => {
      const prReviews = reviews.filter(r => r.pr_id === pr.github_pr_number);
      return prReviews.some(r => r.review_state === 'changes_requested');
    }).length,
    averageApprovals: pullRequests.length > 0 
      ? pullRequests.reduce((sum, pr) => sum + pr.current_approvals_count, 0) / pullRequests.length 
      : 0,
  };
  
  res.json(analytics);
});
```

---

## 🚀 Development Setup

### 1. Xcode Project Setup

**Create New macOS Project:**
1. Open Xcode
2. Create new project → macOS → App
3. Product Name: `ConnectorPRDashboard`
4. Interface: SwiftUI
5. Language: Swift
6. Minimum Deployment: macOS 12.0

**Project Structure:**
```
ConnectorPRDashboard/
├── ConnectorPRDashboardApp.swift
├── ContentView.swift
├── Models/
│   ├── PullRequest.swift
│   ├── Review.swift
│   ├── Comment.swift
│   └── Analytics.swift
├── Views/
│   ├── DashboardView.swift
│   ├── PullRequestsView.swift
│   ├── PRDetailView.swift
│   └── Components/
│       ├── PRCardView.swift
│       ├── MetricCard.swift
│       └── FilterChip.swift
├── ViewModels/
│   ├── DashboardViewModel.swift
│   └── PullRequestsViewModel.swift
├── Services/
│   ├── APIService.swift
│   └── WebSocketService.swift
└── Utils/
    ├── Extensions.swift
    └── Constants.swift
```

### 2. App Entry Point

**ConnectorPRDashboardApp.swift:**
```swift
import SwiftUI

@main
struct ConnectorPRDashboardApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
    }
}
```

**ContentView.swift:**
```swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem {
                    Image(systemName: "chart.bar.fill")
                    Text("Dashboard")
                }
            
            PullRequestsView()
                .tabItem {
                    Image(systemName: "list.bullet")
                    Text("Pull Requests")
                }
        }
        .frame(minWidth: 1000, minHeight: 700)
    }
}
```

---

## 🧪 Testing Strategy

### 1. Unit Tests

**Test Data Models:**
```swift
import XCTest
@testable import ConnectorPRDashboard

class PullRequestTests: XCTestCase {
    func testPRStatusDecoding() {
        let json = """
        {
            "id": 1,
            "github_pr_number": 123,
            "title": "Test PR",
            "author": "testuser",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "merged_at": null,
            "status": "open",
            "is_connector_integration": true,
            "current_approvals_count": 2,
            "labels": ["feature"],
            "reviewers": ["reviewer1"],
            "requested_reviewers": ["reviewer2"],
            "pending_reviewers": ["reviewer2"],
            "url": "https://github.com/test/repo/pull/123"
        }
        """.data(using: .utf8)!
        
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        
        XCTAssertNoThrow(try decoder.decode(PullRequest.self, from: json))
    }
}
```

### 2. API Service Tests

```swift
class APIServiceTests: XCTestCase {
    var apiService: APIService!
    
    override func setUp() {
        super.setUp()
        apiService = APIService()
    }
    
    func testFetchPRs() async throws {
        // Mock URLSession for testing
        let prs = try await apiService.fetchPRs()
        XCTAssertNotNil(prs)
    }
}
```

### 3. UI Tests

```swift
class ConnectorPRDashboardUITests: XCTestCase {
    var app: XCUIApplication!
    
    override func setUp() {
        super.setUp()
        app = XCUIApplication()
        app.launch()
    }
    
    func testDashboardLoads() {
        XCTAssertTrue(app.staticTexts["Dashboard"].exists)
        XCTAssertTrue(app.staticTexts["Total PRs"].exists)
    }
    
    func testPullRequestsTabNavigation() {
        app.buttons["Pull Requests"].click()
        XCTAssertTrue(app.staticTexts["Pull Requests"].exists)
    }
}
```

---

## 📦 Deployment Guide

### 1. Code Signing

**Setup Developer Account:**
1. Enroll in Apple Developer Program
2. Create App ID in Developer Portal
3. Generate certificates and provisioning profiles

**Xcode Configuration:**
1. Project Settings → Signing & Capabilities
2. Select Team and Bundle Identifier
3. Enable "Automatically manage signing"

### 2. Build Configuration

**Release Build Settings:**
```swift
// Build Settings
SWIFT_COMPILATION_MODE = wholemodule
SWIFT_OPTIMIZATION_LEVEL = -O
GCC_OPTIMIZATION_LEVEL = s
ENABLE_BITCODE = NO (for macOS)
```

### 3. Distribution Options

**Option 1: Mac App Store**
1. Archive app in Xcode
2. Upload to App Store Connect
3. Submit for review

**Option 2: Direct Distribution**
1. Archive and export for Developer ID
2. Notarize with Apple
3. Distribute via GitHub releases

**Option 3: Development Distribution**
1. Export for development
2. Share .app bundle directly

---

## 🔄 Migration Timeline

### Week 1: Foundation
- **Day 1-2**: Set up Xcode project and basic structure
- **Day 3-4**: Implement data models and API service
- **Day 5-7**: Create basic UI components and navigation

### Week 2: Core Features
- **Day 1-3**: Implement Dashboard view with metrics
- **Day 4-5**: Build Pull Requests list and detail views
- **Day 6-7**: Add WebSocket integration and real-time updates

### Week 3: Polish & Testing
- **Day 1-2**: UI polish and native macOS features
- **Day 3-4**: Error handling and edge cases
- **Day 5-7**: Testing, bug fixes, and deployment preparation

---

## 🎯 Success Metrics

### Performance Targets
- **App Launch**: < 2 seconds
- **Data Loading**: < 5 seconds for full PR list
- **Memory Usage**: < 100MB typical usage
- **CPU Usage**: < 10% during normal operation

### Feature Completeness
- ✅ All core PR management features
- ✅ Real-time updates via WebSocket
- ✅ Native macOS UI patterns
- ✅ Search and filtering capabilities
- ✅ Responsive design for different window sizes

### User Experience Goals
- **Intuitive Navigation**: Tab-based interface
- **Fast Performance**: Native rendering
- **Reliable Updates**: Real-time data synchronization
- **Professional Appearance**: Native macOS design language

---

## 📚 Additional Resources

### SwiftUI Learning
- [Apple SwiftUI Documentation](https://developer.apple.com/documentation/swiftui)
- [SwiftUI by Example](https://www.hackingwithswift.com/quick-start/swiftui)
- [WWDC SwiftUI Sessions](https://developer.apple.com/videos/swiftui)

### macOS Development
- [macOS App Development Guide](https://developer.apple.com/macos/)
- [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/macos)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

### API Integration
- [URLSession Documentation](https://developer.apple.com/documentation/foundation/urlsession)
- [Combine Framework](https://developer.apple.com/documentation/combine)
- [WebSocket Implementation](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)

---

## 🔧 Troubleshooting

### Common Issues

**1. CORS Errors**
- Ensure backend allows `localhost` origins
- Check API base URL configuration

**2. WebSocket Connection Failures**
- Verify WebSocket URL format (`ws://` not `http://`)
- Check firewall and network settings

**3. Data Decoding Errors**
- Verify JSON structure matches Swift models
- Check date formatting and CodingKeys

**4. Performance Issues**
- Use `@MainActor` for UI updates
- Implement proper async/await patterns
- Avoid blocking the main thread

### Debug Tools
- **Xcode Debugger**: Breakpoints and variable inspection
- **Network Debugging**: Charles Proxy or Wireshark
- **Performance Profiling**: Instruments.app
- **Console Logging**: Unified logging system

---

This comprehensive migration guide provides everything needed to successfully convert the React TypeScript Connector PR Dashboard into a native macOS SwiftUI application. The guide maintains all core functionality while leveraging native macOS capabilities for improved performance and user experience.

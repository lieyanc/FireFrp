# 变量
APP_NAME := firefrp
VERSION := 0.1.0
BUILD_DIR := dist
GO_FLAGS := -ldflags "-s -w -X main.version=$(VERSION)"

# 默认目标
.PHONY: all
all: build

# 本地构建
.PHONY: build
build:
	go build $(GO_FLAGS) -o $(APP_NAME) ./cmd/firefrp/

# 交叉编译
.PHONY: build-all
build-all: build-linux-amd64 build-linux-arm64 build-darwin-amd64 build-darwin-arm64 build-windows-amd64

build-linux-amd64:
	GOOS=linux GOARCH=amd64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(APP_NAME)-linux-amd64 ./cmd/firefrp/

build-linux-arm64:
	GOOS=linux GOARCH=arm64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(APP_NAME)-linux-arm64 ./cmd/firefrp/

build-darwin-amd64:
	GOOS=darwin GOARCH=amd64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(APP_NAME)-darwin-amd64 ./cmd/firefrp/

build-darwin-arm64:
	GOOS=darwin GOARCH=arm64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(APP_NAME)-darwin-arm64 ./cmd/firefrp/

build-windows-amd64:
	GOOS=windows GOARCH=amd64 go build $(GO_FLAGS) -o $(BUILD_DIR)/$(APP_NAME)-windows-amd64.exe ./cmd/firefrp/

# 清理
.PHONY: clean
clean:
	rm -f $(APP_NAME)
	rm -rf $(BUILD_DIR)

# Go mod
.PHONY: tidy
tidy:
	go mod tidy

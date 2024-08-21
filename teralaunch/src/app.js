const { invoke } = window.__TAURI__.tauri;
const { listen } = window.__TAURI__.event;
const { appWindow } = window.__TAURI__.window;
const { message } = window.__TAURI__.dialog;

const REQUIRED_PRIVILEGE_LEVEL = 0;

const App = {
    translations: {},
    currentLanguage: 'EUR',
    languages: {
        EUR: "ENGLISH",
        FRA: "FRENCH",
        RUS: "RUSSIAN",
        GER: "GERMAN"
    },
    launchGameBtn: null,
    statusEl: null,
    loadingModal: null,
    loadingMessage: null,
    loadingError: null,
    refreshButton: null,
    quitTheApp: null,
    deferredUpdate: null,

    // Global application state
    state: {
        speedHistory: [],
        speedHistoryMaxLength: 10,
        isUpdateAvailable: false,
        isDownloadComplete: false,
        lastProgressUpdate: null,
        lastDownloadedBytes: 0,
        currentUpdateMode: null,
        currentProgress: 0,
        currentFileName: '',
        currentFileIndex: 0,
        totalFiles: 0,
        downloadedSize: 0,
        totalSize: 0,
        currentSpeed: 0,
        timeRemaining: 0,
        isLoggingIn: false,
        isLoggingOut: false,
        isGameRunning: false,
        updatesEnabled: true,
        isCheckingForUpdates: false,
        updateCheckPerformed: false,
        isGameLaunching: false,
        isAuthenticated: false,
        isFileCheckComplete: false,
        isFirstLaunch: true,
        isGeneratingHashFile: false,
        hashFileProgress: 0,
        currentProcessingFile: '',
        processedFiles: 0,
    },

    setState(newState) {
        if (newState.totalSize !== undefined && this.state.totalSize === undefined) {
            this.state.totalSize = newState.totalSize;
        }
        if (newState.totalDownloadedBytes !== undefined && this.state.totalDownloadedBytes === undefined) {
            this.state.totalDownloadedBytes = 0;
        }
        Object.assign(this.state, newState);
        this.updateUI();
    },

    async init() {
        try {
            this.disableContextMenu();
            this.setupEventListeners();
            this.setupWindowControls();
            this.setupCustomAnimations();
            this.initializeLoadingModalElements();
            this.setupModalButtonEventHandlers();
            await this.updateLanguageSelector();
            this.Router.setupEventListeners();
            await this.Router.navigate();
            this.sendStoredAuthInfoToBackend();
            this.setupMutationObserver();

            this.checkAuthentication();
            document.addEventListener('DOMContentLoaded', () => {
                this.resetState();
                this.updateUI();
            });

            //just for debug
            //localStorage.setItem('isFirstLaunch','true');


            if (this.state.isAuthenticated && this.Router.currentRoute === 'home') {
                // Check server connection on refresh
                const isConnected = await this.checkServerConnection();
                if (isConnected) {
                    this.checkFirstLaunch();
                    if (this.state.isFirstLaunch) {
                        await this.handleFirstLaunch();
                    } else {
                        await this.initializeAndCheckUpdates(false);
                    }
                } else {
                    console.error('Failed to connect to server on refresh');
                    // Handle connection error (e.g., display a message to the user)
                }
            }
        } catch (error) {
            console.error('Error during app initialization:', error);
        }
    },

    // function to check if it's the first launch
    checkFirstLaunch() {
        const isFirstLaunch = localStorage.getItem('isFirstLaunch') !== 'false';
        this.setState({ isFirstLaunch });
    },

    setupEventListeners() {
        window.addEventListener('DOMContentLoaded', () => {
            this.handleRouteChange();
            this.setupCustomAnimations();
        });

        window.addEventListener('hashchange', () => this.handleRouteChange());

        this.setupGameStatusListeners();
        this.setupUpdateListeners();
        this.setupErrorListener();
    },

    setupGameStatusListeners() {
        listen('game_status', async (event) => {
            console.log("Game status update:", event.payload);
            const isRunning = event.payload === 'GAME_STATUS_RUNNING';
            this.updateUIForGameStatus(isRunning);
        });

        listen('game_status_changed', (event) => {
            const isRunning = event.payload;
            this.updateUIForGameStatus(isRunning);
        });

        listen('game_ended', () => {
            console.log("Game has ended");
            this.updateUIForGameStatus(false);
            this.toggleModal('log-modal', false);
        });
    },

    setupUpdateListeners() {
        listen('download_progress', this.handleDownloadProgress.bind(this));
        listen('file_check_progress', this.handleFileCheckProgress.bind(this));
        listen('file_check_completed', this.handleFileCheckCompleted.bind(this));
        listen('download_complete', () => {
            this.setState({
                isDownloadComplete: true,
                currentProgress: 100,
                currentUpdateMode: 'complete'
            });
        });
    },

    setupErrorListener() {
        listen('error', (event) => {
            this.showErrorMessage(event.payload);
        });
    },


    // Function to handle the first launch
    async handleFirstLaunch() {
        console.log('First time launch detected');
        this.showFirstLaunchModal();
    },

    // Function to show a custom modal for first launch
    showFirstLaunchModal() {
        const modal = document.createElement('div');
        modal.id = 'first-launch-modal';
        modal.innerHTML = `
            <div class="first-launch-modal-content">
                <h2>${this.t('WELCOME_TO_LAUNCHER')}</h2>
                <p>${this.t('FIRST_LAUNCH_MESSAGE')}</p>
                <button id="set-game-path-btn">${this.t('SET_GAME_PATH')}</button>
            </div>
        `;
        document.body.appendChild(modal);

        const setGamePathBtn = document.getElementById('set-game-path-btn');
        setGamePathBtn.addEventListener('click', () => {
            this.closeFirstLaunchModal();
            this.openGamePathSettings();
        });

        anime({
            targets: modal,
            opacity: [0, 1],
            scale: [0.9, 1],
            duration: 300,
            easing: 'easeOutQuad'
        });
    },

    // Function to close the first launch modal
    closeFirstLaunchModal() {
        const modal = document.getElementById('first-launch-modal');
        anime({
            targets: modal,
            opacity: 0,
            scale: 0.9,
            duration: 300,
            easing: 'easeInQuad',
            complete: () => {
                modal.remove();
            }
        });
    },

    // Function to open game path settings
    openGamePathSettings() {
        const settingsBtn = document.getElementById('openModal');
        if (settingsBtn) {
            settingsBtn.click();
        }
    },

    // Function to complete the first launch process
    completeFirstLaunch() {
        localStorage.setItem('isFirstLaunch', 'false');
        this.setState({ isFirstLaunch: false });

        // Proceed with update check
        this.checkServerConnection().then(isConnected => {
            if (isConnected) {
                this.initializeAndCheckUpdates(false);
            }
        });
    },

    // Function for custom notifications
    showCustomNotification(message, type) {
        const notification = document.createElement('div');
        notification.className = `custom-notification ${type}`;
        notification.textContent = message;
        document.body.appendChild(notification);

        anime({
            targets: notification,
            opacity: [0, 1],
            translateY: [-20, 0],
            duration: 300,
            easing: 'easeOutQuad'
        });

        setTimeout(() => {
            anime({
                targets: notification,
                opacity: 0,
                translateY: -20,
                duration: 300,
                easing: 'easeInQuad',
                complete: () => {
                    notification.remove();
                }
            });
        }, 5000);
    },


    handleDownloadProgress(event) {
        if (!event || !event.payload) {
            console.error("Invalid event or payload received in handleDownloadProgress");
            return;
        }

        const {
            file_name,
            progress,
            speed,
            downloaded_bytes,
            total_bytes,
            total_files,
            current_file_index
        } = event.payload;

        console.log("Received download progress event:", event.payload);

        // Ensure totalSize is initialized correctly
        if (this.state.totalSize === undefined || this.state.totalSize === 0) {
            this.state.totalSize = total_bytes;
        }

        // Update total downloaded bytes
        const totalDownloadedBytes = downloaded_bytes;

        // Calculate global remaining time using totalDownloadedBytes
        const timeRemaining = this.calculateGlobalTimeRemaining(totalDownloadedBytes, this.state.totalSize, speed);

        console.log("Calculated download progress:", {
            speed,
            totalDownloadedBytes,
            timeRemaining
        });

        this.setState({
            currentFileName: file_name,
            currentProgress: Math.min(100, progress),
            currentSpeed: speed,
            downloadedSize: downloaded_bytes,
            totalSize: total_bytes,
            totalFiles: total_files,
            currentFileIndex: current_file_index,
            totalDownloadedBytes: totalDownloadedBytes,
            timeRemaining: timeRemaining,
            currentUpdateMode: 'download',
            lastProgressUpdate: Date.now(),
            lastDownloadedBytes: downloaded_bytes
        });

        console.log("Updated state:", this.state);
    },

    handleFileCheckProgress(event) {
        if (!event || !event.payload) {
            console.error("Invalid event or payload received in file_check_progress listener");
            return;
        }

        const {
            current_file,
            progress,
            current_count,
            total_files
        } = event.payload;

        this.setState({
            isUpdateAvailable: true,
            currentFileName: current_file,
            currentProgress: Math.min(100, progress),
            currentFileIndex: current_count,
            totalFiles: total_files,
            currentUpdateMode: 'file_check'
        });
    },

    handleFileCheckCompleted(event) {
        const { total_files, files_to_update, total_time_seconds, average_time_per_file_ms } = event.payload;
        this.setState({
            isFileCheckComplete: true,
            currentUpdateMode: 'complete'
        });
        this.handleCompletion();
    },

    handleUpdateCompleted() {
        this.setState({
            isUpdateComplete: true,
            currentUpdateMode: 'complete'
        });
    },

    updateUI() {
        if (!this.deferredUpdate) {
            this.deferredUpdate = requestAnimationFrame(() => {
                this.updateUIElements();
                this.deferredUpdate = null;
            });
        }
    },

    updateUIElements() {
        const elements = {
            statusString: document.getElementById('status-string'),
            currentFile: document.getElementById('current-file'),
            filesProgress: document.getElementById('files-progress'),
            downloadedSize: document.getElementById('downloaded-size'),
            totalSize: document.getElementById('total-size'),
            progressPercentage: document.getElementById('progress-percentage'),
            progressPercentageDiv: document.getElementById('progress-percentage-div'),
            downloadSpeed: document.getElementById('download-speed'),
            timeRemaining: document.getElementById('time-remaining'),
            dlStatusString: document.getElementById('dl-status-string'),
        };

        if (elements.timeRemaining) {
            const timeText = this.state.currentUpdateMode === 'download' ?
                this.formatTime(this.state.timeRemaining) : '';
            console.log('Formatted time:', timeText);
            elements.timeRemaining.textContent = timeText || 'Calculating...';
        }

        this.updateTextContents(elements);
        this.updateProgressBar(elements);
        this.updateDownloadInfo(elements);
        this.updateElementsVisibility(elements);
    },

    updateTextContents(elements) {
        if (elements.dlStatusString) {
            elements.dlStatusString.textContent = this.getDlStatusString();
        }
        if (elements.statusString) elements.statusString.textContent = this.getStatusText();
        if (elements.currentFile) elements.currentFile.textContent = this.getFileName(this.state.currentFileName);
        if (elements.filesProgress) elements.filesProgress.textContent = `(${this.state.currentFileIndex}/${this.state.totalFiles})`;
        if (elements.downloadedSize) elements.downloadedSize.textContent = this.formatSize(this.state.downloadedSize);
        if (elements.totalSize) elements.totalSize.textContent = this.formatSize(this.state.totalSize);
    },

    updateProgressBar(elements) {
        const progress = Math.min(100, this.calculateProgress());
        if (elements.progressPercentage) {
            if (this.state.currentUpdateMode === 'ready') {
                elements.progressPercentage.style.display = 'none';
                elements.currentFile.style.display = 'none'
            } else {
                elements.progressPercentage.style.display = 'inline';
                elements.progressPercentage.textContent = `(${Math.round(progress)}%)`;
                elements.currentFile.style.display = 'flex !important'
            }
        }
        if (elements.progressPercentageDiv) {

            if (this.state.currentUpdateMode === 'ready') {
                elements.currentFile.style.display = 'none'
            } else {
                elements.progressPercentageDiv.style.width = `${progress}%`;
                elements.currentFile.style.display = 'flex !important'
            }
        }
    },

    updateDownloadInfo(elements) {
        console.log('Current update mode:', this.state.currentUpdateMode);
        console.log('Current speed:', this.state.currentSpeed);
        console.log('Time remaining:', this.state.timeRemaining);

        if (elements.downloadSpeed) {
            const speedText = this.state.currentUpdateMode === 'download' ?
                this.formatSpeed(this.state.currentSpeed) : '';
            console.log('Formatted speed:', speedText);
            elements.downloadSpeed.textContent = speedText;
            console.log('Download speed element updated:', elements.downloadSpeed.textContent);
        } else {
            console.log('Download speed element not found');
        }
        if (elements.timeRemaining) {
            const timeText = this.state.currentUpdateMode === 'download' ?
                this.formatTime(this.state.timeRemaining) : '';
            console.log('Formatted time:', timeText);
            elements.timeRemaining.textContent = timeText;
            console.log('Time remaining element updated:', elements.timeRemaining.textContent);
        } else {
            console.log('Time remaining element not found');
        }
    },

    getDlStatusString() {
        switch (this.state.currentUpdateMode) {
            case 'file_check':
                return this.t('VERIFYING_FILES');
            case 'download':
                return this.t('DOWNLOADING_FILES');
            case 'complete':
                if (this.state.isFileCheckComplete && !this.state.isUpdateAvailable) {
                    return this.t('NO_UPDATE_REQUIRED');
                } else if (this.state.isFileCheckComplete && this.state.isUpdateAvailable) {
                    return this.t('FILE_CHECK_COMPLETE');
                } else if (this.state.isDownloadComplete) {
                    return this.t('DOWNLOAD_COMPLETE');
                } else if (this.state.isUpdateComplete) {
                    return this.t('UPDATE_COMPLETED');
                }
                break;
            default:
                return this.t('GAME_READY_TO_LAUNCH');
        }

        return this.t('GAME_READY_TO_LAUNCH');
    },

    calculateProgress() {
        if (this.state.isUpdateAvailable && this.state.totalSize > 0) {
            return (this.state.downloadedSize / this.state.totalSize) * 100;
        }
        return this.state.currentProgress;
    },

    getStatusText() {
        if (this.state.isDownloadComplete) return this.t('DOWNLOAD_COMPLETE');
        if (!this.state.isUpdateAvailable) return this.t('NO_UPDATE_REQUIRED');
        return this.t(this.state.currentUpdateMode === 'file_check' ? 'VERIFYING_FILES' : 'DOWNLOADING_FILES');
    },

    updateElementsVisibility(elements) {
        const showDownloadInfo = this.state.isUpdateAvailable && this.state.currentUpdateMode === 'download';

        if (elements.currentFile) elements.currentFile.style.display = this.state.isUpdateAvailable ? 'flex' : 'none';
        if (elements.filesProgress) elements.filesProgress.style.display = this.state.isUpdateAvailable ? 'inline' : 'none';
        if (elements.downloadedSize && elements.downloadedSize.parentElement) {
            elements.downloadedSize.parentElement.style.display = showDownloadInfo ? 'inline' : 'none';
        }
        if (elements.totalSize && elements.totalSize.parentElement) {
            elements.totalSize.parentElement.style.display = showDownloadInfo ? 'inline' : 'none';
        }
        if (elements.progressPercentage) {
            elements.progressPercentage.style.display =
                (this.state.isUpdateAvailable && this.state.currentUpdateMode !== 'ready') ? 'inline' : 'none';
        }
        if (elements.downloadSpeed) elements.downloadSpeed.style.display = showDownloadInfo ? 'inline' : 'none';
        if (elements.timeRemaining) elements.timeRemaining.style.display = showDownloadInfo ? 'inline' : 'none';
    },

    resetState() {
        this.setState({
            isFileCheckComplete: false,
            isUpdateAvailable: false,
            isDownloadComplete: false,
            lastProgressUpdate: null,
            lastDownloadedBytes: 0,
            currentUpdateMode: null,
            currentProgress: 0,
            currentFileName: '',
            currentFileIndex: 0,
            totalFiles: 0,
            downloadedSize: 0,
            totalSize: 0,
            currentSpeed: 0,
            timeRemaining: 0,
            isLoggingIn: false,
            isLoggingOut: false,
            isGameRunning: false,
            updateCheckPerformed: false,
            isGeneratingHashFile: false,
            hashFileProgress: 0,
            currentProcessingFile: '',
            processedFiles: 0,
        });
    },

    handleCompletion() {
        this.setState({
            isDownloadComplete: true,
            currentProgress: 100,
            currentUpdateMode: 'complete'
        });
        setTimeout(() => {
            this.setState({
                isUpdateComplete: true,
                currentUpdateMode: 'ready'
            });
            // Re-enable the game launch button and language selector
            this.updateLaunchGameButton(false);
            this.toggleLanguageSelector(true);
        }, 2000);
    },

    async initializeAndCheckUpdates(isLogin = false) {
        const checkNeeded = isLogin ? !this.state.updateCheckPerformedOnLogin : !this.state.updateCheckPerformedOnRefresh;

        if (!checkNeeded) {
            console.log(isLogin ? 'Update check already performed after login' : 'Update check already performed on refresh');
            return;
        }

        try {
            await this.initializeHomePage();
            this.checkFirstLaunch();
            if (this.state.isFirstLaunch) {
                await this.handleFirstLaunch();
            } else {
                await this.checkForUpdates();
            }

            if (isLogin) {
                this.setState({ updateCheckPerformedOnLogin: true });
            } else {
                this.setState({ updateCheckPerformedOnRefresh: true });
            }
        } catch (error) {
            console.error('Error during initialization and update check:', error);
            // Handle the error (e.g., display a message to the user)
        }
    },

    async checkForUpdates() {
        if (this.state.isCheckingForUpdates) {
            console.log('Update check already in progress');
            return;
        }

        this.setState({ isCheckingForUpdates: true, currentUpdateMode: 'file_check' });
        // Disable the game launch button and language selector during the check
        this.updateLaunchGameButton(true);
        this.toggleLanguageSelector(false);

        try {
            this.resetState();

            const filesToUpdate = await invoke('get_files_to_update');

            if (filesToUpdate.length === 0) {
                this.setState({
                    isUpdateAvailable: false,
                    isFileCheckComplete: true,
                    currentUpdateMode: 'complete'
                });
                // Re-enable elements if no update is needed
                this.updateLaunchGameButton(false);
                this.toggleLanguageSelector(true);
                setTimeout(() => {
                    this.setState({ currentUpdateMode: 'ready' });
                }, 1000);
            } else {
                this.setState({
                    isUpdateAvailable: true,
                    isFileCheckComplete: true,
                    currentUpdateMode: 'complete',
                    totalFiles: filesToUpdate.length,
                    totalSize: filesToUpdate.reduce((total, file) => total + file.size, 0)
                });
                setTimeout(async () => {
                    this.setState({ currentUpdateMode: 'download' });
                    await this.runPatchSystem(filesToUpdate);
                }, 2000);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
            this.resetState();
            this.showErrorMessage(this.t('UPDATE_SERVER_UNREACHABLE'));
            // Re-enable elements in case of error
            this.updateLaunchGameButton(false);
            this.toggleLanguageSelector(true);
        } finally {
            this.setState({ isCheckingForUpdates: false });
        }
    },

    async runPatchSystem(filesToUpdate) {
        try {
            // Disable the game launch button and language selector at the start of the process
            this.updateLaunchGameButton(true);
            this.toggleLanguageSelector(false);

            if (filesToUpdate.length === 0) {
                console.log("No update needed");
                // Re-enable elements if no update is needed
                this.updateLaunchGameButton(false);
                this.toggleLanguageSelector(true);
                return;
            }

            const downloadedSizes = await invoke('download_all_files', {
                filesToUpdate: filesToUpdate
            });

            let totalDownloadedSize = 0;
            let lastUpdateTime = Date.now();
            let lastDownloadedSize = 0;
            for (let i = 0; i < downloadedSizes.length; i++) {
                const fileInfo = filesToUpdate[i];
                const downloadedSize = downloadedSizes[i];
                totalDownloadedSize += downloadedSize;

                this.setState({
                    currentFileName: fileInfo.path,
                    currentFileIndex: i + 1,
                    downloadedSize: totalDownloadedSize
                });

                const currentTime = Date.now();
                const timeDiff = (currentTime - lastUpdateTime) / 1000; // in seconds
                const sizeDiff = totalDownloadedSize - lastDownloadedSize;
                const speed = sizeDiff / timeDiff; // bytes per second

                // Emit a progress event if necessary
                this.handleDownloadProgress({
                    payload: {
                        file_name: fileInfo.path,
                        progress: (totalDownloadedSize / this.state.totalSize) * 100,
                        speed: speed,
                        downloaded_bytes: totalDownloadedSize,
                        total_bytes: this.state.totalSize,
                        total_files: this.state.totalFiles,
                        current_file_index: i + 1
                    }
                });

                lastUpdateTime = currentTime;
                lastDownloadedSize = totalDownloadedSize;
            }

            this.handleCompletion();
        } catch (error) {
            console.error('Error during update:', error);
            this.showErrorMessage(this.t('UPDATE_ERROR_MESSAGE'));
        } finally {
            // Re-enable the game launch button and language selector at the end of the process
            this.updateLaunchGameButton(false);
            this.toggleLanguageSelector(true);
        }
    },

    async login(username, password) {
        if (this.state.isLoggingIn) {
            console.log("A login attempt is already in progress.");
            return;
        }

        this.setState({ isLoggingIn: true });
        const loginButton = document.getElementById('login-button');
        const loginErrorMsg = document.getElementById('login-error-msg');

        if (loginButton) {
            loginButton.disabled = true;
            loginButton.textContent = this.t('LOGIN_IN_PROGRESS');
        }

        if (loginErrorMsg) {
            loginErrorMsg.style.display = 'none';
        }

        try {
            console.log('invoke login from backend');
            const response = await invoke('login', { username, password });
            const jsonResponse = JSON.parse(response);

            if (jsonResponse.Return && jsonResponse.Msg === "success") {
                this.storeAuthInfo(jsonResponse);
                console.log('Login success');

                // Check server connection after successful login
                const isConnected = await this.checkServerConnection();

                if (isConnected) {
                    console.log('Login success 2');
                    await this.initializeAndCheckUpdates(true)
                    await this.Router.navigate('home');
                } else {
                    throw new Error(this.t('SERVER_CONNECTION_ERROR'));
                }
            } else {
                throw new Error(jsonResponse.Msg || this.t('LOGIN_ERROR'));
            }
        } catch (error) {
            console.error('Error during login:', error);
            if (loginErrorMsg) {
                loginErrorMsg.textContent = error.message || this.t('SERVER_CONNECTION_ERROR');
                loginErrorMsg.style.display = 'block';
            }
        } finally {
            this.setState({ isLoggingIn: false });
            if (loginButton) {
                loginButton.disabled = false;
                loginButton.textContent = this.t('LOGIN_BUTTON');
            }
        }
    },

    storeAuthInfo(jsonResponse) {
        localStorage.setItem('authKey', jsonResponse.AuthKey);
        localStorage.setItem('userName', jsonResponse.UserName);
        localStorage.setItem('userNo', jsonResponse.UserNo.toString());
        localStorage.setItem('characterCount', jsonResponse.CharacterCount.toString());
        localStorage.setItem('permission', jsonResponse.Permission.toString());
        localStorage.setItem('privilege', jsonResponse.Privilege.toString());

        invoke('set_auth_info', {
            authKey: jsonResponse.AuthKey,
            userName: jsonResponse.UserName,
            userNo: jsonResponse.UserNo,
            characterCount: jsonResponse.CharacterCount
        });

        this.checkAuthentication();
    },

    async initializeHomePage() {
        this.Router.navigate('home');
        await this.waitForHomePage();
        await this.initHome();
    },

    waitForHomePage() {
        return new Promise((resolve) => {
            const checkDom = () => {
                if (document.getElementById('home-page')) {
                    resolve();
                } else {
                    setTimeout(checkDom, 100);
                }
            };
            checkDom();
        });
    },

    async logout() {
        if (this.state.isLoggingOut) {
            console.log("A logout is already in progress.");
            return;
        }

        this.setState({ isLoggingOut: true });
        try {
            await invoke('handle_logout');
            localStorage.removeItem('authKey');
            localStorage.removeItem('userName');
            localStorage.removeItem('userNo');
            localStorage.removeItem('characterCount');
            localStorage.removeItem('permission');
            localStorage.removeItem('privilege');

            this.setState({
                updateCheckPerformed: false,
                updateCheckPerformedOnLogin: false,
                updateCheckPerformedOnRefresh: false
            });
            this.Router.navigate('login');
            this.resetState();
            this.checkAuthentication();
        } catch (error) {
            console.error('Error during logout:', error);
        } finally {
            this.setState({ isLoggingOut: false });
        }
    },

    async changeLanguage(newLang) {
        if (newLang !== this.currentLanguage) {
            this.currentLanguage = newLang;
            await invoke('save_language_to_config', { language: this.currentLanguage });
            console.log(`Language saved to config: ${this.currentLanguage}`);

            await this.loadTranslations();
            await this.updateAllUIElements();

            const isGameRunning = await invoke("get_game_status");
            this.setState({ isGameRunning: isGameRunning });
        }
    },

    async updateAllUIElements() {
        await this.updateAllTranslations();
        this.updateUI();
    },

    updateDynamicTranslations() {
        if (this.statusEl) {
            this.statusEl.textContent = this.t(this.state.isGameRunning ? 'GAME_STATUS_RUNNING' : 'GAME_STATUS_NOT_RUNNING');
        }
        if (this.launchGameBtn) {
            this.launchGameBtn.textContent = this.t('LAUNCH_GAME');
        }
    },

    toggleLanguageSelector(enable) {
        const selectWrapper = document.querySelector('.select-wrapper');
        const selectStyled = selectWrapper?.querySelector('.select-styled');

        if (selectWrapper && selectStyled) {
            if (enable) {
                selectWrapper.classList.remove('disabled');
                selectStyled.style.pointerEvents = 'auto';
            } else {
                selectWrapper.classList.add('disabled');
                selectStyled.style.pointerEvents = 'none';
            }
        }
    },

    async handleLaunchGame() {
        if (this.state.isGameLaunching) {
            console.log("Game launch already in progress");
            return;
        }

        this.setState({ isGameLaunching: true });

        try {
            this.updateUIForGameStatus(true);
            if (this.statusEl) this.statusEl.textContent = this.t('LAUNCHING_GAME');

            await this.subscribeToLogs();

            console.log("Creating log modal");
            this.createLogModal();

            console.log("Attempting to show log modal");
            this.toggleModal('log-modal', true);

            // Check if the modal is visible
            const logModal = document.getElementById('log-modal');
            if (logModal) {
                console.log("Log modal display style:", logModal.style.display);
            } else {
                console.log("Log modal element not found");
            }

            const result = await invoke("handle_launch_game");
            console.log("Game launch result:", result);
        } catch (error) {
            console.error("Error initiating game launch:", error);
            if (this.statusEl) this.statusEl.textContent = this.t('GAME_LAUNCH_ERROR', error.toString());
            await invoke("reset_launch_state");
            this.updateUIForGameStatus(false);
        } finally {
            this.setState({ isGameLaunching: false });
        }
    },

    async updateGameStatus() {
        try {
            const isRunning = await invoke("get_game_status");
            this.updateUIForGameStatus(isRunning);
        } catch (error) {
            console.error("Error checking game status:", error);
            if (this.statusEl) this.statusEl.textContent = this.t('GAME_STATUS_ERROR');
        }
    },

    updateUIForGameStatus(isRunning) {
        if (this.statusEl) {
            this.statusEl.textContent = isRunning ? this.t('GAME_STATUS_RUNNING') : this.t('GAME_STATUS_NOT_RUNNING');
        }
        this.updateLaunchGameButton(isRunning);
        this.toggleLanguageSelector(!isRunning);
    },

    updateLaunchGameButton(disabled) {
        if (this.launchGameBtn) {
            this.launchGameBtn.disabled = disabled;
            this.launchGameBtn.classList.toggle('disabled', disabled);
        }
    },

    updateHashFileProgressUI() {
        const modal = document.getElementById('hash-file-progress-modal');
        if (!modal || modal.style.display === 'none') {
            return; // Ne pas mettre à jour si le modal n'est pas visible
        }
    
        const progressBar = modal.querySelector('.hash-progress-bar');
        const currentFileEl = modal.querySelector('#hash-file-current-file');
        const progressTextEl = modal.querySelector('#hash-file-progress-text');
    
        if (progressBar) {
            progressBar.style.width = `${this.state.hashFileProgress}%`;
            progressBar.textContent = `${Math.round(this.state.hashFileProgress)}%`;
        }
    
        if (currentFileEl) {
            const processingFileText = this.t('PROCESSING_FILE');
            currentFileEl.textContent = `${processingFileText}: ${this.state.currentProcessingFile}`;
        }
    
        if (progressTextEl) {
            const progressText = this.t('PROGRESS_TEXT');
            progressTextEl.textContent = `${progressText} ${this.state.processedFiles}/${this.state.totalFiles} (${this.state.hashFileProgress.toFixed(2)}%)`;
        }
    
        // Mettre à jour le titre du modal si nécessaire
        const modalTitle = modal.querySelector('h2');
        if (modalTitle) {
            modalTitle.textContent = this.t('GENERATING_HASH_FILE');
        }
    },

    async isGameRunning() {
        try {
            const isRunning = await invoke("get_game_status");
            return isRunning;
        } catch (error) {
            console.error("Error checking game status:", error);
            return false;
        }
    },

    async checkServerConnection() {
        console.log('Checking server connection');
        this.showLoadingModal(this.t('CHECKING_SERVER_CONNECTION'));
        try {
            const isConnected = await invoke('check_server_connection');
            this.hideLoadingModal();
            if (isConnected) {
                console.log('Server connection successful');
            } else {
                console.log('Server connection failed');
            }
            return isConnected;
        } catch (error) {
            console.error('Server connection error:', error);
            this.showLoadingError(this.t('SERVER_CONNECTION_ERROR'));
            return false;
        } finally {
            console.log('Server connection check complete');
        }
    },

    formatSize(bytes) {
        if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = parseFloat(bytes);
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        return `${size.toFixed(2)} ${units[unitIndex]}`;
    },

    formatSpeed(bytesPerSecond) {
        if (!isFinite(bytesPerSecond) || bytesPerSecond < 0) return '0 B/s';
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let speed = bytesPerSecond;
        let unitIndex = 0;
        while (speed >= 1024 && unitIndex < units.length - 1) {
            speed /= 1024;
            unitIndex++;
        }
        return `${speed.toFixed(2)} ${units[unitIndex]}`;
    },

    calculateGlobalTimeRemaining(totalDownloadedBytes, totalSize, speed) {
        console.log("Calculating global time remaining:", { totalDownloadedBytes, totalSize, speed });
        if (!isFinite(speed) || speed <= 0 || !isFinite(totalDownloadedBytes) || !isFinite(totalSize) || totalDownloadedBytes >= totalSize) {
            console.log("Invalid input for global time remaining calculation");
            return 0;
        }
        let bytesRemaining = totalSize - totalDownloadedBytes;

        let averageSpeed = this.calculateAverageSpeed(speed);

        let secondsRemaining = bytesRemaining / averageSpeed;
        console.log("Calculated time remaining:", secondsRemaining);
        return Math.min(secondsRemaining, 30 * 24 * 60 * 60); // Limit to 30 days maximum
    },

    // Updated calculateAverageSpeed method
    calculateAverageSpeed(currentSpeed) {
        // Add current speed to history
        this.state.speedHistory.push(currentSpeed);

        // Limit history size
        if (this.state.speedHistory.length > this.state.speedHistoryMaxLength) {
            this.state.speedHistory.shift(); // Remove oldest value
        }

        // Calculate average speed
        const sum = this.state.speedHistory.reduce((acc, speed) => acc + speed, 0);
        const averageSpeed = sum / this.state.speedHistory.length;

        console.log("Speed history:", this.state.speedHistory);
        console.log("Average speed:", averageSpeed);

        return averageSpeed;
    },

    formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return 'Calculating...';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        if (hours > 0) {
            return `${hours}h ${minutes}m ${remainingSeconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    },

    getFileName(path) {
        return path ? path.split('\\').pop().split('/').pop() : '';
    },

    showErrorMessage(message) {
        const errorContainer = document.getElementById('error-container');
        if (errorContainer) {
            errorContainer.textContent = message;
            errorContainer.style.display = 'block';
            setTimeout(() => {
                errorContainer.style.display = 'none';
            }, 5000);
        }
    },


    // Updated methods for loading modal
    showLoadingModal(message) {
        this.toggleModal('loading-modal', true, message);

        // Specific handling for loading modal elements
        if (this.loadingError) {
            this.loadingError.textContent = '';
            this.loadingError.style.display = 'none';
        }
        if (this.refreshButton) {
            this.refreshButton.style.display = 'none';
        }
        if (this.quitTheApp) {
            this.quitTheApp.style.display = 'none';
        }
    },

    hideLoadingModal() {
        this.toggleModal('loading-modal', false);
    },



    toggleModal(modalId, show, message = '') {
        const modal = document.getElementById(modalId);
        if (!modal) {
            console.error(`Modal with id ${modalId} not found`);
            return;
        }

        console.log(`Toggling modal ${modalId}, show: ${show}`);

        modal.classList.toggle('show', show);
        modal.style.display = show ? 'block' : 'none';

        // Handle message for loading modal
        if (modalId === 'loading-modal' && message) {
            const messageElement = modal.querySelector('.loading-message');
            if (messageElement) {
                messageElement.textContent = message;
            }
        }

        console.log(`Modal ${modalId} visibility:`, modal.classList.contains('show'));
    },

    toggleHashProgressModal(show, message = '', isComplete = false) {
        const modal = document.getElementById('hash-file-progress-modal');
        if (!modal) {
            console.error('Hash file progress modal not found');
            return;
        }
    
        console.log(`Toggling hash progress modal, show: ${show}`);
    
        if (show) {
            modal.classList.add('show', 'hash-modal-fade-in');
            modal.style.display = 'block';
    
            // Handle message for hash file progress modal
            const messageElement = modal.querySelector('#hash-file-progress-text');
            if (messageElement && message) {
                messageElement.textContent = message;
            }
    
            if (isComplete) {
                // Show success message
                const successMessage = this.t('HASH_FILE_GENERATION_COMPLETE');
                const successElement = document.createElement('div');
                successElement.id = 'hash-success-message';
                successElement.textContent = successMessage;

                const modalContent = modal.querySelector('.hash-progress-modal') || modal;
                modalContent.appendChild(successElement);
    
                // Wait 5 seconds, then close the modal
                setTimeout(() => {
                    this.toggleHashProgressModal(false);
                }, 5000);
            }
        } else {
            modal.classList.remove('show', 'hash-modal-fade-in');
            
            // Use a fade-out animation
            anime({
                targets: modal,
                opacity: 0,
                duration: 500,
                easing: 'easeOutQuad',
                complete: () => {
                    modal.style.display = 'none';
                    modal.style.opacity = 1; // Reset opacity for next time
    
                    // Remove success message if it exists
                    const successElement = modal.querySelector('#hash-success-message');
                    if (successElement) {
                        successElement.remove();
                    }
                }
            });
        }
    
        console.log(`Hash progress modal visibility:`, modal.classList.contains('show'));
    },



    //method to display the loading indicator
    showLoadingIndicator() {
        let loadingIndicator = document.getElementById('loading-indicator');
        if (!loadingIndicator) {
            loadingIndicator = document.createElement('div');
            loadingIndicator.id = 'loading-indicator';
            loadingIndicator.innerHTML = '<div class="spinner"></div>';
            document.body.appendChild(loadingIndicator);
        }
        loadingIndicator.style.display = 'flex';
    },

    //method to hide the loading indicator
    hideLoadingIndicator() {
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) {
            loadingIndicator.style.display = 'none';
        }
    },

    showLoadingError(errorMessage) {
        const loadingModal = document.getElementById('loading-modal');
        if (loadingModal) {
            const errorElement = loadingModal.querySelector('.loading-error');
            if (errorElement) {
                errorElement.textContent = errorMessage;
                errorElement.style.display = 'block';
            }

            const refreshButton = loadingModal.querySelector('#refresh-button');
            if (refreshButton) {
                refreshButton.style.display = 'inline-block';
            }

            const quitButton = loadingModal.querySelector('#quit-button');
            if (quitButton) {
                quitButton.style.display = 'inline-block';
            }
        }
    },

    showNotification(message, type) {
        const notification = document.getElementById('notification');
        if (notification) {
            notification.textContent = message;
            notification.className = `notification ${type}`;

            // Show the notification
            gsap.fromTo(notification,
                { opacity: 0, y: -20 },
                { duration: 0.5, opacity: 1, y: 0, display: 'block', ease: 'power2.out' }
            );

            // Hide the notification after 5 seconds
            gsap.to(notification, {
                delay: 5,
                duration: 0.5,
                opacity: 0,
                y: -20,
                display: 'none',
                ease: 'power2.in'
            });
        }
    },

    async loadTranslations() {
        try {
            const response = await fetch('translations.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.translations = await response.json();
        } catch (error) {
            console.error('Error loading translations:', error);
            this.translations = { [this.currentLanguage]: {} };
        }
    },

    t(key, ...args) {
        const translations = this.translations[this.currentLanguage] || {};
        let str = translations[key] || key;
        return str.replace(/\{(\d+)\}/g, (_, index) => args[index] || '');
    },

    async updateLanguageSelector() {
        try {
            this.currentLanguage = await invoke('get_language_from_config');
            console.log(`Language loaded from config: ${this.currentLanguage}`);

            const selectWrapper = document.querySelector('.select-wrapper');
            const selectStyled = selectWrapper?.querySelector('.select-styled');
            const selectOptions = selectWrapper?.querySelector('.select-options');
            const originalSelect = selectWrapper?.querySelector('select');

            if (selectWrapper && selectStyled && selectOptions && originalSelect) {
                this.setupLanguageOptions(selectOptions, originalSelect);
                this.setupLanguageEventListeners(selectStyled, selectOptions);

                const currentLanguageName = this.languages[this.currentLanguage] || this.currentLanguage;
                selectStyled.textContent = currentLanguageName;
                originalSelect.value = this.currentLanguage;
            } else {
                console.warn('Language selector elements not found in the DOM');
            }

            await this.loadTranslations();
            await this.updateAllTranslations();
        } catch (error) {
            console.error('Error updating language selector:', error);
            this.currentLanguage = 'EUR';
            await this.loadTranslations();
            await this.updateAllTranslations();
        }
    },

    setupLanguageOptions(selectOptions, originalSelect) {
        selectOptions.innerHTML = '';
        originalSelect.innerHTML = '';

        for (const [code, name] of Object.entries(this.languages)) {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = name;
            originalSelect.appendChild(option);

            const li = document.createElement('li');
            li.setAttribute('rel', code);
            li.textContent = name;
            selectOptions.appendChild(li);
        }
    },

    setupLanguageEventListeners(selectStyled, selectOptions) {
        selectOptions.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', async (e) => {
                const newLang = e.target.getAttribute('rel');
                if (newLang !== this.currentLanguage) {
                    await this.changeLanguage(newLang);
                    selectStyled.textContent = e.target.textContent;
                }
            });
        });
    },

    async updateAllTranslations() {
        document.querySelectorAll('[data-translate]').forEach(el => {
            const key = el.getAttribute('data-translate');
            el.textContent = this.t(key);
        });

        document.querySelectorAll('[data-translate-placeholder]').forEach(el => {
            const key = el.getAttribute('data-translate-placeholder');
            el.placeholder = this.t(key);
        });

        this.updateDynamicTranslations();
    },

    initLogin() {
        console.log('Initializing login page');
        const loginButton = document.getElementById('login-button');

        if (loginButton) {
            loginButton.addEventListener('click', async () => {
                console.log('Login button clicked');
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                await this.login(username, password);
            });
        }
    },

    async initHome() {
        const sliderContainer = document.querySelector('.slider-container');

        const swiper = new Swiper('.news-slider', {
            effect: 'fade',
            fadeEffect: {
                crossFade: true
            },
            speed: 1500,
            loop: true,
            autoplay: {
                delay: 5000,
                disableOnInteraction: false,
            },
            pagination: {
                el: '.swiper-pagination',
                clickable: true,
            },
            navigation: {
                nextEl: '.swiper-button-next',
                prevEl: '.swiper-button-prev',
            },
            on: {
                slideChangeTransitionStart: function () {
                    sliderContainer.classList.add('pulse');
                },
                slideChangeTransitionEnd: function () {
                    sliderContainer.classList.remove('pulse');
                }
            }
        });

        this.setupHomePageElements();
        this.setupHomePageEventListeners();
        await this.initializeHomePageComponents();
    },

    setupHomePageElements() {
        this.launchGameBtn = document.querySelector("#launch-game-btn");
        this.statusEl = document.querySelector("#game-status");
    },

    setupHomePageEventListeners() {
        if (this.launchGameBtn) {
            this.launchGameBtn.addEventListener("click", () => this.handleLaunchGame());
        }

        const logoutButton = document.getElementById('logout-link');
        if (logoutButton) {
            logoutButton.addEventListener('click', async (e) => {
                console.log('Logout button clicked');
                e.preventDefault();
                await this.logout();
            });
        }

        const generateHashFileBtn = document.getElementById('generate-hash-file');
        if (generateHashFileBtn && this.checkPrivilegeLevel()) {
            generateHashFileBtn.style.display = 'block';
            generateHashFileBtn.addEventListener('click', () => this.generateHashFile());
        }

        const appQuitButton = document.getElementById('app-quit');
        if (appQuitButton) {
            appQuitButton.addEventListener('click', () => this.appQuit());
        }
    },

    async initializeHomePageComponents() {
        await this.loadGamePath();
        this.initUserPanel();
        this.initModalSettings();
        await this.updateGameStatus();
        this.updateUIBasedOnPrivileges();
        this.updateUI();
        const isGameRunning = await this.isGameRunning();
        this.updateUIForGameStatus(isGameRunning);
    },

    // Update the initUserPanel method
    initUserPanel() {
        const btnUserAvatar = document.querySelector('.btn-user-avatar');
        const dropdownPanelWrapper = document.querySelector('.dropdown-panel-wrapper');
        if (!btnUserAvatar || !dropdownPanelWrapper) {
            console.warn('User panel elements not found in the DOM');
            return;
        }

        // Initialize panel state
        let isPanelOpen = false;

        // Set up initial animation
        gsap.set(dropdownPanelWrapper, {
            display: 'none',
            opacity: 0,
            y: -10
        });

        // Create a reusable GSAP timeline
        const tl = gsap.timeline({ paused: true });
        tl.to(dropdownPanelWrapper, {
            duration: 0.3,
            display: 'block',
            opacity: 1,
            y: 0,
            ease: 'power2.out'
        });

        // Event handler for the button
        btnUserAvatar.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!isPanelOpen) {
                tl.play();
            } else {
                tl.reverse();
            }
            isPanelOpen = !isPanelOpen;
        });

        // Close panel when clicking outside
        document.addEventListener('click', () => {
            if (isPanelOpen) {
                tl.reverse();
                isPanelOpen = false;
            }
        });

        // Prevent closing when clicking inside the panel
        dropdownPanelWrapper.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        console.log('User panel initialized');
    },

    initModalSettings() {
        const modal = document.getElementById('modal');
        const btn = document.getElementById('openModal');
        const span = document.getElementsByClassName('close')[0];
        const input = document.getElementById('gameFolder');

        if (!modal || !btn || !span || !input) {
            console.warn('Modal elements not found in the DOM');
            return;
        }

        this.setupModalEventListeners(modal, btn, span, input);
    },

    setupModalEventListeners(modal, btn, span, input) {
        input.onclick = async () => {
            try {
                const selectedPath = await invoke('select_game_folder');
                if (selectedPath) {
                    input.value = selectedPath;
                    await this.saveGamePath(selectedPath);
                    this.showNotification(this.t('FOLDER_SAVED_SUCCESS'), 'success');
                }
            } catch (error) {
                console.error('Error selecting game folder:', error);
                this.showNotification(this.t('FOLDER_SELECTION_ERROR'), 'error');
            }
        };

        btn.onclick = () => {
            gsap.to(modal, { duration: 0.5, display: 'flex', opacity: 1, ease: 'power2.inOut' });
        };

        span.onclick = () => this.closeModal(modal);

        input.onchange = () => {
            if (input.value.toLowerCase().includes('tera')) {
                this.showNotification(this.t('FOLDER_FOUND_SUCCESS'), 'success');
            } else {
                this.showNotification(this.t('FOLDER_NOT_FOUND'), 'error');
            }
        };

        window.onclick = (event) => {
            if (event.target == modal) {
                this.closeModal(modal);
            }
        };
    },

    closeModal(modal) {
        gsap.to(modal, {
            duration: 0.5,
            opacity: 0,
            ease: 'power2.inOut',
            onComplete: () => {
                modal.style.display = 'none';
            }
        });
    },

    initializeLoadingModalElements() {
        this.loadingModal = document.getElementById('loading-modal');
        if (this.loadingModal) {
            this.loadingMessage = this.loadingModal.querySelector('.loading-message');
            this.loadingError = this.loadingModal.querySelector('.loading-error');
            this.refreshButton = this.loadingModal.querySelector('#refresh-button');
            this.quitTheApp = this.loadingModal.querySelector('#quit-button');
        } else {
            console.error('Loading modal elements not found in the DOM');
        }
    },

    setupModalButtonEventHandlers() {
        if (this.refreshButton) {
            this.refreshButton.addEventListener('click', async () => {
                const isConnected = await this.checkServerConnection();
                if (isConnected && this.state.isAuthenticated) {
                    await this.initializeAndCheckUpdates();
                }
            });
        }
        if (this.quitTheApp) {
            this.quitTheApp.addEventListener('click', () => this.appQuit());
        }
    },

    createLogModal() {
        let modal = document.getElementById('log-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'log-modal';
            modal.innerHTML = `
                <div class="log-modal-content">
                    <div class="log-modal-header">
                        <h2>${this.t('GAME_LOGS')}</h2>
                        <span class="log-modal-close">&times;</span>
                    </div>
                    <div id="log-console"></div>
                </div>
            `;
            document.body.appendChild(modal);

            const closeBtn = modal.querySelector('.log-modal-close');
            closeBtn.onclick = () => this.toggleModal('log-modal', false);
        }
        console.log("Log modal created/checked");
    },

    appendLogMessage(message) {
        const console = document.getElementById('log-console');
        if (console) {
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            const time = new Date().toLocaleTimeString();

            let logLevel = 'info'; // Default log level
            let messageContent = message;
            const logLevels = ['INFO', 'DEBUG', 'WARN', 'ERROR', 'CRITICAL'];

            // Remove any leading log level from the message
            for (const level of logLevels) {
                if (messageContent.startsWith(level + ': ')) {
                    messageContent = messageContent.substring(level.length + 2);
                    break;
                }
            }

            // Detect log level
            for (const level of logLevels) {
                if (messageContent.startsWith(level + ' -')) {
                    logLevel = level.toLowerCase();
                    messageContent = messageContent.substring(level.length + 2).trim();
                    break;
                }
            }

            logEntry.innerHTML = `
                <span class="log-entry-time">[${time}]</span>
                <span class="log-entry-level ${logLevel}">${logLevel.toUpperCase()}:</span>
                <span class="log-entry-message">${messageContent}</span>
            `;
            console.appendChild(logEntry);
            console.scrollTop = console.scrollHeight;
        }
    },

    async subscribeToLogs() {
        console.log("Attempting to subscribe to logs");

        await listen('log_message', (event) => {
            //console.log("Received log message:", event.payload);
            this.appendLogMessage(event.payload);
        });

        console.log("Log subscription set up successfully");
    },

    async saveGamePath(path) {
        try {
            await invoke('save_game_path_to_config', { path });
            console.log('Game path saved successfully');
            if (this.state.isFirstLaunch) {
                this.completeFirstLaunch();
                this.showCustomNotification(this.t('GAME_PATH_SET_FIRST_LAUNCH'), 'success');
            } else {
                this.showCustomNotification(this.t('GAME_PATH_UPDATED'), 'success');
            }
        } catch (error) {
            console.error('Error saving game path:', error);
            this.showCustomNotification(this.t('GAME_PATH_SAVE_ERROR'), 'error');
            throw error;
        }
    },

    async loadGamePath() {
        try {
            const path = await invoke('get_game_path_from_config');
            const input = document.getElementById('gameFolder');
            if (input) {
                input.value = path;
            }
        } catch (error) {
            console.error('Error loading game path:', error);
            // Display the error in a Windows system message
            const errorMessage = `${this.t('GAME_PATH_LOAD_ERROR')} ${error.message}`;
            const userResponse = await message(
                errorMessage,
                { title: this.t('ERROR'), type: 'error' }
            );
            if (userResponse) {
                this.appQuit();
            }
        }
    },

    setupWindowControls() {
        const appMinimizeBtn = document.getElementById('app-minimize');
        if (appMinimizeBtn) {
            appMinimizeBtn.addEventListener('click', () => appWindow.minimize());
        }

        const appCloseBtn = document.getElementById('app-close');
        if (appCloseBtn) {
            appCloseBtn.addEventListener('click', () => this.appQuit());
        }
    },

    setupCustomAnimations() {
        const selectWrapper = document.querySelector('.select-wrapper');
        if (selectWrapper) {
            const selectStyled = selectWrapper.querySelector('.select-styled');
            const selectOptions = selectWrapper.querySelector('.select-options');
            const originalSelect = selectWrapper.querySelector('select');

            if (selectStyled && selectOptions && originalSelect) {
                this.setupSelectAnimation(selectStyled, selectOptions, originalSelect);
            }
        }
    },

    setupSelectAnimation(selectStyled, selectOptions, originalSelect) {
        selectStyled.addEventListener('click', (e) => {
            e.stopPropagation();
            selectStyled.classList.toggle('active');
            this.animateSelectOptions(selectOptions);
        });

        selectOptions.querySelectorAll('li').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleSelectOptionClick(e.target, selectStyled, selectOptions, originalSelect);
            });
        });

        document.addEventListener('click', () => {
            selectStyled.classList.remove('active');
            this.animateSelectOptions(selectOptions, true);
        });
    },

    animateSelectOptions(selectOptions, hide = false) {
        anime({
            targets: selectOptions,
            opacity: hide ? [1, 0] : [0, 1],
            translateY: hide ? [0, -10] : [-10, 0],
            duration: 300,
            easing: 'easeOutQuad',
            begin: (anim) => {
                if (!hide) selectOptions.style.display = 'block';
            },
            complete: (anim) => {
                if (hide) selectOptions.style.display = 'none';
            }
        });
    },

    handleSelectOptionClick(target, selectStyled, selectOptions, originalSelect) {
        selectStyled.textContent = target.textContent;
        originalSelect.value = target.getAttribute('rel');
        selectStyled.classList.remove('active');
        this.animateSelectOptions(selectOptions, true);
        anime({
            targets: selectStyled,
            scale: [1, 1.05, 1],
            duration: 300,
            easing: 'easeInOutQuad'
        });
    },

    setupMutationObserver() {
        const targetNode = document.getElementById('dl-status-string');
        if (targetNode) {
            const config = { childList: true, subtree: true };
            const callback = (mutationsList, observer) => {
                for (let mutation of mutationsList) {
                    if (mutation.type === 'childList') {
                        console.log('Mutation detected in dl-status-string');
                        this.updateUI();
                    }
                }
            };
            this.observer = new MutationObserver(callback);
            this.observer.observe(targetNode, config);
        }
    },

    updateUIBasedOnPrivileges() {
        const generateHashFileBtn = document.getElementById('generate-hash-file');
        if (generateHashFileBtn) {
            generateHashFileBtn.style.display = this.checkPrivilegeLevel() ? 'block' : 'none';
        }
    },

    checkAuthentication() {
        this.setState({ isAuthenticated: localStorage.getItem('authKey') !== null });
    },

    checkPrivilegeLevel() {
        const userPrivilege = parseInt(localStorage.getItem('privilege'), 10);
        return !isNaN(userPrivilege) && userPrivilege >= REQUIRED_PRIVILEGE_LEVEL;
    },

    async sendStoredAuthInfoToBackend() {
        const authKey = localStorage.getItem('authKey');
        const userName = localStorage.getItem('userName');
        const userNo = parseInt(localStorage.getItem('userNo'), 10);
        const characterCount = localStorage.getItem('characterCount');

        if (authKey && userName && userNo && characterCount) {
            await invoke('set_auth_info', {
                authKey,
                userName,
                userNo,
                characterCount
            });
        }
    },


    async generateHashFile() {
        if (this.state.isGeneratingHashFile) {
            console.log("Hash file generation is already in progress");
            return;
        }
    
        try {
            this.setState({
                isGeneratingHashFile: true,
                hashFileProgress: 0,
                currentProcessingFile: '',
                processedFiles: 0,
                totalFiles: 0
            });
    
            const generateHashBtn = document.getElementById('generate-hash-file');
            if (generateHashBtn) {
                generateHashBtn.disabled = true;
            }
    
            this.toggleHashProgressModal(true, this.t('INITIALIZING_HASH_GENERATION'));
    
            const unlistenProgress = await listen('hash_file_progress', (event) => {
                const { current_file, progress, processed_files, total_files, total_size } = event.payload;
                
                this.setState({
                    hashFileProgress: progress,
                    currentProcessingFile: current_file,
                    processedFiles: processed_files,
                    totalFiles: total_files
                });
    
                this.updateHashFileProgressUI();
            });
    
            const result = await invoke('generate_hash_file');
            console.log('Hash file generation result:', result);
            this.toggleHashProgressModal(true, '', true);
            this.showNotification(this.t('HASH_FILE_GENERATED'), 'success');
        } catch (error) {
            console.error('Error generating hash file:', error);
            this.showNotification(this.t('HASH_FILE_GENERATION_ERROR'), 'error');
        } finally {
    
            this.setState({
                isGeneratingHashFile: false,
                hashFileProgress: 0,
                currentProcessingFile: '',
                processedFiles: 0,
                totalFiles: 0
            });
    
            const generateHashBtn = document.getElementById('generate-hash-file');
            if (generateHashBtn) {
                generateHashBtn.disabled = false;
            }
    
            if (unlistenProgress) {
                unlistenProgress();
            }
        }
    },

    disableContextMenu() {
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        document.addEventListener('selectstart', (e) => {
            e.preventDefault();
        });
    },

    appQuit() {
        appWindow.close();
    },

    handleRouteChange() {
        console.log('Route change detected');
        this.Router.navigate();
    },

    async loadAsyncContent(file) {
        console.log('Loading file:', file);
        const response = await fetch(file);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const content = await response.text();
        console.log('File loaded successfully');

        return content;
    },

    async smoothPageTransition(app, newPage) {
        const currentPage = app.querySelector('.page');

        newPage.style.position = 'absolute';
        newPage.style.top = '0';
        newPage.style.left = '0';
        newPage.style.width = '100%';
        newPage.style.opacity = '0';
        newPage.style.transform = 'translateX(20px)';

        app.appendChild(newPage);

        if (currentPage) {
            await anime({
                targets: currentPage,
                opacity: [1, 0],
                translateX: [0, -20],
                easing: 'easeInOutQuad',
                duration: 300
            }).finished;

            currentPage.remove();
        }

        await anime({
            targets: newPage,
            opacity: [0, 1],
            translateX: [20, 0],
            easing: 'easeOutQuad',
            duration: 300
        }).finished;

        newPage.style.position = '';
        newPage.style.top = '';
        newPage.style.left = '';
        newPage.style.width = '';
        newPage.style.transform = '';
    },
};

// Create the Router and attach it to App
App.Router = createRouter(App);

// Expose App globally if necessary
window.App = App;

// Initialize the app when the DOM is fully loaded
window.addEventListener('DOMContentLoaded', () => App.init());    
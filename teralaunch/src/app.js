const { invoke } = window.__TAURI__.tauri;
const { listen } = window.__TAURI__.event;
const { appWindow } = window.__TAURI__.window;
const { message } = window.__TAURI__.dialog;

const REQUIRED_PRIVILEGE_LEVEL = 3;
const UPDATE_CHECK_ENABLED = false;

const App = {
  translations: {},
  currentLanguage: "EUR",
  languages: {
    EUR: "ENGLISH",
    FRA: "FRENCH",
    RUS: "RUSSIAN",
    GER: "GERMAN",
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
    lastLogMessage: null,
    lastLogTime: 0,
    speedHistory: [],
    speedHistoryMaxLength: 10,
    isUpdateAvailable: false,
    isDownloadComplete: false,
    lastProgressUpdate: null,
    lastDownloadedBytes: 0,
    currentUpdateMode: null,
    currentProgress: 0,
    currentFileName: "",
    currentFileIndex: 0,
    totalFiles: 0,
    downloadedSize: 0,
    totalSize: 0,
    currentSpeed: 0,
    timeRemaining: 0,
    isLoggingIn: false,
    isLoggingOut: false,
    isGameRunning: false,
    gameExecutionFailed: false,
    updatesEnabled: true,
    isCheckingForUpdates: false,
    updateCheckPerformed: false,
    isGameLaunching: false,
    isAuthenticated: false,
    isFileCheckComplete: false,
    isFirstLaunch: true,
    isGeneratingHashFile: false,
    hashFileProgress: 0,
    currentProcessingFile: "",
    processedFiles: 0,
  },

  /**
   * Updates the global application state.
   *
   * If `newState.totalSize` is provided, it will be used to initialize the
   * `totalSize` field in the state if it is currently undefined. If
   * `newState.totalDownloadedBytes` is provided, it will be used to initialize
   * the `totalDownloadedBytes` field in the state if it is currently undefined.
   *
   * Otherwise, the state is updated by shallow-merging `newState` into the
   * existing state.
   *
   * Finally, the UI is updated by calling `this.updateUI()`.
   *
   * @param {Object} newState - The new state to update the application with.
   * @param {number} [newState.totalSize] - The total size of the download.
   * @param {number} [newState.totalDownloadedBytes] - The total number of bytes
   *   downloaded so far.
   */
  setState(newState) {
    if (
      newState.totalSize !== undefined &&
      this.state.totalSize === undefined
    ) {
      this.state.totalSize = newState.totalSize;
    }
    if (
      newState.totalDownloadedBytes !== undefined &&
      this.state.totalDownloadedBytes === undefined
    ) {
      this.state.totalDownloadedBytes = 0;
    }
    Object.assign(this.state, newState);
    this.updateUI();
  },

  /**
   * Initializes the app by setting up event listeners, window controls, animations,
   * modal elements, and navigation. It also sends stored authentication information
   * to the backend, sets up a mutation observer, and checks if the user is authenticated.
   * If the user is authenticated and the current route is 'home', it checks if the app
   * is running for the first time and handles it accordingly. If the app is not running
   * for the first time, it checks for updates. If updates are disabled, it skips the
   * update check and server connection.
   */
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
      document.addEventListener("DOMContentLoaded", () => {
        this.resetState();
        this.updateUI();
      });

      //just for debug
      //localStorage.setItem('isFirstLaunch','true');

      if (this.state.isAuthenticated && this.Router.currentRoute === "home") {
        if (!UPDATE_CHECK_ENABLED) {
          console.log(
            "Updates are disabled, skipping update check and server connection",
          );
          this.setState({
            isUpdateAvailable: false,
            isFileCheckComplete: true,
            currentUpdateMode: "complete",
            currentProgress: 100,
          });
          this.updateUI();
          return; // Exit the function early if updates are disabled
        }

        const isConnected = await this.checkServerConnection();
        if (isConnected) {
          this.checkFirstLaunch();
          if (this.state.isFirstLaunch) {
            await this.handleFirstLaunch();
          } else {
            await this.initializeAndCheckUpdates(false);
          }
        } else {
          console.error("Failed to connect to server on refresh");
          // Handle connection error (e.g., display a message to the user)
        }
      }
    } catch (error) {
      console.error("Error during app initialization:", error);
    }
  },

  // function to check if it's the first launch
  checkFirstLaunch() {
    const isFirstLaunch = localStorage.getItem("isFirstLaunch") !== "false";
    this.setState({ isFirstLaunch });
  },

  /**
   * Sets up event listeners to handle page loading, hash changes, game status events, update events, and errors.
   */
  setupEventListeners() {
    window.addEventListener("DOMContentLoaded", () => {
      this.handleRouteChange();
      this.setupCustomAnimations();
    });

    window.addEventListener("hashchange", () => this.handleRouteChange());

    this.setupGameStatusListeners();
    this.setupUpdateListeners();
    this.setupErrorListener();
  },

  /**
   * Sets up event listeners for game status events from the game server.
   *
   * Listens for the following events:
   *
   * - `game_status`: emitted when the game status is updated. The event payload is either
   *   `GAME_STATUS_RUNNING` or `GAME_STATUS_NOT_RUNNING`.
   * - `game_status_changed`: emitted when the game status changes. The event payload is a
   *   boolean indicating whether the game is running or not.
   * - `game_ended`: emitted when the game has ended. The event payload is empty.
   *
   * When any of these events are received, the UI is updated to reflect the new game status.
   */
  setupGameStatusListeners() {
    listen("game_status", async (event) => {
      console.log("Game status update:", event.payload);
      const isRunning = event.payload === "GAME_STATUS_RUNNING";
      this.updateUIForGameStatus(isRunning);
    });

    listen("game_status_changed", (event) => {
      const isRunning = event.payload;
      this.updateUIForGameStatus(isRunning);
    });

    listen("game_ended", () => {
      console.log("Game has ended");
      this.updateUIForGameStatus(false);
      this.toggleModal("log-modal", false);
    });
  },

  /**
   * Sets up event listeners for update events from the game server.
   *
   * Listens for the following events:
   *
   * - `download_progress`: emitted when the download progress is updated. The event payload is a
   *   DownloadProgress object.
   * - `file_check_progress`: emitted when the file check progress is updated. The event payload is a
   *   FileCheckProgress object.
   * - `file_check_completed`: emitted when the file check is complete. The event payload is an empty
   *   object.
   * - `download_complete`: emitted when the download is complete. The event payload is an empty
   *   object.
   *
   * When any of these events are received, the UI is updated to reflect the new download status.
   */
  setupUpdateListeners() {
    listen("download_progress", this.handleDownloadProgress.bind(this));
    listen("file_check_progress", this.handleFileCheckProgress.bind(this));
    listen("file_check_completed", this.handleFileCheckCompleted.bind(this));
    listen("download_complete", () => {
      this.setState({
        isDownloadComplete: true,
        currentProgress: 100,
        currentUpdateMode: "complete",
      });
    });
  },

  /**
   * Sets up an event listener for error events from the game server.
   *
   * Listens for the following event:
   *
   * - `error`: emitted when an error occurs. The event payload is an error message string.
   *
   * When any of these events are received, the UI is updated to reflect the new error state.
   */
  setupErrorListener() {
    listen("error", (event) => {
      this.showErrorMessage(event.payload);
    });
  },

  // Function to handle the first launch
  async handleFirstLaunch() {
    console.log("First time launch detected");
    this.showFirstLaunchModal();
  },

  // Function to show a custom modal for first launch
  showFirstLaunchModal() {
    const modal = document.createElement("div");
    modal.id = "first-launch-modal";
    modal.innerHTML = `
            <div class="first-launch-modal-content">
                <h2>${this.t("WELCOME_TO_LAUNCHER")}</h2>
                <p>${this.t("FIRST_LAUNCH_MESSAGE")}</p>
                <button id="set-game-path-btn">${this.t("SET_GAME_PATH")}</button>
            </div>
        `;
    document.body.appendChild(modal);

    const setGamePathBtn = document.getElementById("set-game-path-btn");
    setGamePathBtn.addEventListener("click", () => {
      this.closeFirstLaunchModal();
      this.openGamePathSettings();
    });

    anime({
      targets: modal,
      opacity: [0, 1],
      scale: [0.9, 1],
      duration: 300,
      easing: "easeOutQuad",
    });
  },

  // Function to close the first launch modal
  closeFirstLaunchModal() {
    const modal = document.getElementById("first-launch-modal");
    anime({
      targets: modal,
      opacity: 0,
      scale: 0.9,
      duration: 300,
      easing: "easeInQuad",
      complete: () => {
        modal.remove();
      },
    });
  },

  // Function to open game path settings
  openGamePathSettings() {
    const settingsBtn = document.getElementById("openModal");
    if (settingsBtn) {
      settingsBtn.click();
    }
  },

  // Function to complete the first launch process
  completeFirstLaunch() {
    localStorage.setItem("isFirstLaunch", "false");
    this.setState({ isFirstLaunch: false });

    // Proceed with update check
    this.checkServerConnection().then((isConnected) => {
      if (isConnected) {
        this.initializeAndCheckUpdates(false);
      }
    });
  },

  // Function for custom notifications
  showCustomNotification(message, type) {
    const notification = document.createElement("div");
    notification.className = `custom-notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    anime({
      targets: notification,
      opacity: [0, 1],
      translateY: [-20, 0],
      duration: 300,
      easing: "easeOutQuad",
    });

    setTimeout(() => {
      anime({
        targets: notification,
        opacity: 0,
        translateY: -20,
        duration: 300,
        easing: "easeInQuad",
        complete: () => {
          notification.remove();
        },
      });
    }, 5000);
  },

  /**
   * Handles download progress events from the backend.
   * @param {Object} event The event object from the backend.
   * @param {Object} event.payload The payload of the event, containing the following properties:
   *   - file_name: The name of the file being downloaded.
   *   - progress: The percentage of the file downloaded.
   *   - speed: The download speed in bytes per second.
   *   - downloaded_bytes: The total number of bytes downloaded so far.
   *   - total_bytes: The total number of bytes to download.
   *   - total_files: The total number of files to download.
   *   - current_file_index: The index of the current file in the list of files to download.
   */
  handleDownloadProgress(event) {
    if (!event || !event.payload) {
      console.error(
        "Invalid event or payload received in handleDownloadProgress",
      );
      return;
    }

    const {
      file_name,
      progress,
      speed,
      downloaded_bytes,
      total_bytes,
      total_files,
      current_file_index,
    } = event.payload;

    console.log("Received download progress event:", event.payload);

    // Ensure totalSize is initialized correctly
    if (this.state.totalSize === undefined || this.state.totalSize === 0) {
      this.state.totalSize = total_bytes;
    }

    // Update total downloaded bytes
    const totalDownloadedBytes = downloaded_bytes;

    // Calculate global remaining time using totalDownloadedBytes
    const timeRemaining = this.calculateGlobalTimeRemaining(
      totalDownloadedBytes,
      this.state.totalSize,
      speed,
    );

    console.log("Calculated download progress:", {
      speed,
      totalDownloadedBytes,
      timeRemaining,
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
      currentUpdateMode: "download",
      lastProgressUpdate: Date.now(),
      lastDownloadedBytes: downloaded_bytes,
    });

    console.log("Updated state:", this.state);
  },

  /**
   * Handles file check progress events from the backend.
   * @param {Object} event The event object from the backend.
   * @param {Object} event.payload The payload of the event, containing the following properties:
   *   - current_file: The name of the file being checked.
   *   - progress: The percentage of the file check completed.
   *   - current_count: The number of files checked so far.
   *   - total_files: The total number of files to check.
   */
  handleFileCheckProgress(event) {
    if (!event || !event.payload) {
      console.error(
        "Invalid event or payload received in file_check_progress listener",
      );
      return;
    }

    const { current_file, progress, current_count, total_files } =
      event.payload;

    this.setState({
      isUpdateAvailable: true,
      currentFileName: current_file,
      currentProgress: Math.min(100, progress),
      currentFileIndex: current_count,
      totalFiles: total_files,
      currentUpdateMode: "file_check",
    });
  },

  /**
   * Handles file check completed events from the backend.
   * @param {Object} event The event object from the backend.
   * @param {Object} event.payload The payload of the event, containing the following properties:
   *   - total_files: The total number of files to check.
   *   - files_to_update: The number of files that require an update.
   *   - total_time_seconds: The total time taken to check all the files in seconds.
   *   - average_time_per_file_ms: The average time taken to check each file in milliseconds.
   */
  handleFileCheckCompleted(event) {
    const {
      total_files,
      files_to_update,
      total_time_seconds,
      average_time_per_file_ms,
    } = event.payload;
    this.setState({
      isFileCheckComplete: true,
      currentUpdateMode: "complete",
    });
    this.handleCompletion();
  },

  /**
   * Handles update completed events from the backend.
   * Sets the state to indicate that the update is complete.
   */
  handleUpdateCompleted() {
    this.setState({
      isUpdateComplete: true,
      currentUpdateMode: "complete",
    });
  },

  /**
   * Requests an update of the UI elements by scheduling a call to updateUIElements
   * using requestAnimationFrame. This ensures that the UI is updated as soon as
   * possible after the state has changed, without causing unnecessary re-renders.
   * @return {void}
   */
  updateUI() {
    if (!this.deferredUpdate) {
      this.deferredUpdate = requestAnimationFrame(() => {
        this.updateUIElements();
        this.deferredUpdate = null;
      });
    }
  },

  /**
   * Updates the UI elements with the latest state. This function is
   * called when the state of the application changes.
   *
   * @return {void}
   */
  updateUIElements() {
    const elements = {
      statusString: document.getElementById("status-string"),
      currentFile: document.getElementById("current-file"),
      filesProgress: document.getElementById("files-progress"),
      downloadedSize: document.getElementById("downloaded-size"),
      totalSize: document.getElementById("total-size"),
      progressPercentage: document.getElementById("progress-percentage"),
      progressPercentageDiv: document.getElementById("progress-percentage-div"),
      downloadSpeed: document.getElementById("download-speed"),
      timeRemaining: document.getElementById("time-remaining"),
      dlStatusString: document.getElementById("dl-status-string"),
    };

    if (!UPDATE_CHECK_ENABLED) {
      if (elements.dlStatusString)
        elements.dlStatusString.textContent = this.t("NO_UPDATE_REQUIRED");
      if (elements.progressPercentage)
        elements.progressPercentage.textContent = "(100%)";
      if (elements.progressPercentageDiv)
        elements.progressPercentageDiv.style.width = "100%";

      // Hide unnecessary elements
      if (elements.currentFile) elements.currentFile.style.display = "none";
      if (elements.filesProgress) elements.filesProgress.style.display = "none";
      if (elements.downloadedSize && elements.downloadedSize.parentElement)
        elements.downloadedSize.parentElement.style.display = "none";
      if (elements.totalSize && elements.totalSize.parentElement)
        elements.totalSize.parentElement.style.display = "none";
      if (elements.downloadSpeed) elements.downloadSpeed.style.display = "none";
      if (elements.timeRemaining) elements.timeRemaining.style.display = "none";

      return; // Exit the function because we don't need to update other elements
    }

    if (elements.timeRemaining) {
      const timeText =
        this.state.currentUpdateMode === "download"
          ? this.formatTime(this.state.timeRemaining)
          : "";
      console.log("Formatted time:", timeText);
      elements.timeRemaining.textContent = timeText || "Calculating...";
    }

    this.updateTextContents(elements);
    this.updateProgressBar(elements);
    this.updateDownloadInfo(elements);
    this.updateElementsVisibility(elements);
  },

  /**
   * Updates the text content of the elements in the object with the relevant text from the state.
   * @param {Object} elements - An object containing the elements to be updated. Can contain the following properties:
   *      dlStatusString: The element to display the download status string.
   *      statusString: The element to display the status string.
   *      currentFile: The element to display the current file name.
   *      filesProgress: The element to display the progress of the file check (e.g. 10/100).
   *      downloadedSize: The element to display the downloaded size.
   *      totalSize: The element to display the total size.
   */
  updateTextContents(elements) {
    if (elements.dlStatusString) {
      elements.dlStatusString.textContent = this.getDlStatusString();
    }
    if (elements.statusString)
      elements.statusString.textContent = this.getStatusText();
    if (elements.currentFile)
      elements.currentFile.textContent = this.getFileName(
        this.state.currentFileName,
      );
    if (elements.filesProgress)
      elements.filesProgress.textContent = `(${this.state.currentFileIndex}/${this.state.totalFiles})`;
    if (elements.downloadedSize)
      elements.downloadedSize.textContent = this.formatSize(
        this.state.downloadedSize,
      );
    if (elements.totalSize)
      elements.totalSize.textContent = this.formatSize(this.state.totalSize);
  },

  /**
   * Updates the progress bar elements in the object with the relevant progress.
   * @param {Object} elements - An object containing the elements to be updated. Can contain the following properties:
   *      progressPercentage: The element to display the progress percentage.
   *      progressPercentageDiv: The element to display the progress bar itself.
   *      currentFile: The element to display the current file name.
   */
  updateProgressBar(elements) {
    const progress = Math.min(100, this.calculateProgress());
    if (elements.progressPercentage) {
      if (this.state.currentUpdateMode === "ready") {
        elements.progressPercentage.style.display = "none";
        elements.currentFile.style.display = "none";
      } else {
        elements.progressPercentage.style.display = "inline";
        elements.progressPercentage.textContent = `(${Math.round(progress)}%)`;
        elements.currentFile.style.display = "flex !important";
      }
    }
    if (elements.progressPercentageDiv) {
      if (this.state.currentUpdateMode === "ready") {
        elements.currentFile.style.display = "none";
      } else {
        elements.progressPercentageDiv.style.width = `${progress}%`;
        elements.currentFile.style.display = "flex !important";
      }
    }
  },

  /**
   * Updates the download info elements in the object with the relevant download information.
   * @param {Object} elements - An object containing the elements to be updated. Can contain the following properties:
   *      downloadSpeed: The element to display the download speed.
   *      timeRemaining: The element to display the time remaining.
   */
  updateDownloadInfo(elements) {
    console.log("Current update mode:", this.state.currentUpdateMode);
    console.log("Current speed:", this.state.currentSpeed);
    console.log("Time remaining:", this.state.timeRemaining);

    if (elements.downloadSpeed) {
      const speedText =
        this.state.currentUpdateMode === "download"
          ? this.formatSpeed(this.state.currentSpeed)
          : "";
      console.log("Formatted speed:", speedText);
      elements.downloadSpeed.textContent = speedText;
      console.log(
        "Download speed element updated:",
        elements.downloadSpeed.textContent,
      );
    } else {
      console.log("Download speed element not found");
    }
    if (elements.timeRemaining) {
      const timeText =
        this.state.currentUpdateMode === "download"
          ? this.formatTime(this.state.timeRemaining)
          : "";
      console.log("Formatted time:", timeText);
      elements.timeRemaining.textContent = timeText;
      console.log(
        "Time remaining element updated:",
        elements.timeRemaining.textContent,
      );
    } else {
      console.log("Time remaining element not found");
    }
  },

  /**
   * Returns the current download status string based on the current update mode.
   * This function will return the following strings based on the current update mode:
   *      'file_check': 'VERIFYING_FILES'
   *      'download': 'DOWNLOADING_FILES'
   *      'complete': If the file check is complete and there is no update available, 'NO_UPDATE_REQUIRED'
   *                  If the file check is complete and there is an update available, 'FILE_CHECK_COMPLETE'
   *                  If the download is complete, 'DOWNLOAD_COMPLETE'
   *                  If the update is complete, 'UPDATE_COMPLETED'
   *      default: 'GAME_READY_TO_LAUNCH'
   *
   * @returns {string} The current download status string
   */
  getDlStatusString() {
    if (!UPDATE_CHECK_ENABLED) {
      return this.t("NO_UPDATE_REQUIRED");
    }

    switch (this.state.currentUpdateMode) {
      case "file_check":
        return this.t("VERIFYING_FILES");
      case "download":
        return this.t("DOWNLOADING_FILES");
      case "complete":
        if (this.state.isFileCheckComplete && !this.state.isUpdateAvailable) {
          return this.t("NO_UPDATE_REQUIRED");
        } else if (
          this.state.isFileCheckComplete &&
          this.state.isUpdateAvailable
        ) {
          return this.t("FILE_CHECK_COMPLETE");
        } else if (this.state.isDownloadComplete) {
          return this.t("DOWNLOAD_COMPLETE");
        } else if (this.state.isUpdateComplete) {
          return this.t("UPDATE_COMPLETED");
        }
        break;
      default:
        return this.t("GAME_READY_TO_LAUNCH");
    }

    return this.t("GAME_READY_TO_LAUNCH");
  },

  /**
   * Calculates the current progress of the update as a percentage.
   * If there is an update available and the total size of the update is greater than 0,
   * the progress is calculated as (downloadedSize / totalSize) * 100.
   * Otherwise, the current progress is returned.
   * @returns {number} The current progress as a percentage
   */
  calculateProgress() {
    if (this.state.isUpdateAvailable && this.state.totalSize > 0) {
      return (this.state.downloadedSize / this.state.totalSize) * 100;
    }
    return this.state.currentProgress;
  },

  /**
   * Returns the current download status string based on the current update mode.
   * If the download is complete, 'DOWNLOAD_COMPLETE' is returned.
   * If there is no update available, 'NO_UPDATE_REQUIRED' is returned.
   * If the file check is being performed, 'VERIFYING_FILES' is returned.
   * If the download is being performed, 'DOWNLOADING_FILES' is returned.
   * @returns {string} The current download status string
   */
  getStatusText() {
    if (this.state.isDownloadComplete) return this.t("DOWNLOAD_COMPLETE");
    if (!this.state.isUpdateAvailable) return this.t("NO_UPDATE_REQUIRED");
    return this.t(
      this.state.currentUpdateMode === "file_check"
        ? "VERIFYING_FILES"
        : "DOWNLOADING_FILES",
    );
  },

  /**
   * Updates the visibility of the given elements based on the current state of the download.
   * If the download is available and the current update mode is 'download',
   * the elements are shown. Otherwise, they are hidden.
   * @param {Object} elements - The elements to update.
   */
  updateElementsVisibility(elements) {
    const showDownloadInfo =
      this.state.isUpdateAvailable &&
      this.state.currentUpdateMode === "download";

    if (elements.currentFile)
      elements.currentFile.style.display = this.state.isUpdateAvailable
        ? "flex"
        : "none";
    if (elements.filesProgress)
      elements.filesProgress.style.display = this.state.isUpdateAvailable
        ? "inline"
        : "none";
    if (elements.downloadedSize && elements.downloadedSize.parentElement) {
      elements.downloadedSize.parentElement.style.display = showDownloadInfo
        ? "inline"
        : "none";
    }
    if (elements.totalSize && elements.totalSize.parentElement) {
      elements.totalSize.parentElement.style.display = showDownloadInfo
        ? "inline"
        : "none";
    }
    if (elements.progressPercentage) {
      elements.progressPercentage.style.display =
        this.state.isUpdateAvailable && this.state.currentUpdateMode !== "ready"
          ? "inline"
          : "none";
    }
    if (elements.downloadSpeed)
      elements.downloadSpeed.style.display = showDownloadInfo
        ? "inline"
        : "none";
    if (elements.timeRemaining)
      elements.timeRemaining.style.display = showDownloadInfo
        ? "inline"
        : "none";
  },

  /**
   * Resets the state to its initial values.
   * This function is called on various events such as the download completing, the user logging out, or the user navigating away from the page.
   * It resets all the state fields to their default values, effectively resetting the state of the download.
   */
  resetState() {
    this.setState({
      isFileCheckComplete: false,
      isUpdateAvailable: false,
      isDownloadComplete: false,
      lastProgressUpdate: null,
      lastDownloadedBytes: 0,
      currentUpdateMode: null,
      currentProgress: 0,
      currentFileName: "",
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
      currentProcessingFile: "",
      processedFiles: 0,
    });
  },

  /**
   * Handles download completion events from the backend.
   * Sets the state to indicate that the download is complete, and after a 2 second delay, sets the state to indicate that the update is complete.
   * Also re-enables the game launch button and language selector.
   */
  handleCompletion() {
    this.setState({
      isDownloadComplete: true,
      currentProgress: 100,
      currentUpdateMode: "complete",
    });
    setTimeout(() => {
      this.setState({
        isUpdateComplete: true,
        currentUpdateMode: "ready",
      });
      // Re-enable the game launch button and language selector
      this.updateLaunchGameButton(false);
      this.toggleLanguageSelector(true);
    }, 2000);
  },

  /**
   * Initializes the home page and checks for updates if needed.
   * If the first launch flag is set, it handles the first launch by generating the hash file.
   * If not, it checks for updates and sets the state accordingly.
   * If an error occurs during initialization and update check, it logs the error but does not display it to the user.
   * @param {boolean} [isLogin=false] Whether the update check is triggered by a login action.
   */
  async initializeAndCheckUpdates(isLogin = false) {
    if (!UPDATE_CHECK_ENABLED) {
      console.log("Updates are disabled");
      this.setState({
        isUpdateAvailable: false,
        isFileCheckComplete: true,
        currentUpdateMode: "complete",
        currentProgress: 100,
      });
      this.updateUI();
      return;
    }

    const checkNeeded = isLogin
      ? !this.state.updateCheckPerformedOnLogin
      : !this.state.updateCheckPerformedOnRefresh;

    if (!checkNeeded) {
      console.log(
        isLogin
          ? "Update check already performed after login"
          : "Update check already performed on refresh",
      );
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
      console.error("Error during initialization and update check:", error);
      // Handle the error (e.g., display a message to the user)
    }
  },

  /**
   * Checks for updates if needed. If no update is needed, it disables the update check button and
   * sets the state to indicate that the update is complete. If an update is needed, it sets the
   * state to indicate that the update is available and starts the update process.
   * If an error occurs, it logs the error and displays an error message to the user.
   * @param {boolean} [isLogin=false] Whether the update check is triggered by a login action.
   */
  async checkForUpdates() {
    if (!UPDATE_CHECK_ENABLED) {
      console.log("Update checks are disabled");
      this.setState({
        isUpdateAvailable: false,
        isFileCheckComplete: true,
        currentUpdateMode: "complete",
        currentProgress: 100,
      });
      this.updateUI();
      return;
    }

    if (this.state.isCheckingForUpdates) {
      console.log("Update check already in progress");
      return;
    }

    this.setState({
      isCheckingForUpdates: true,
      currentUpdateMode: "file_check",
    });
    // Disable the game launch button and language selector during the check
    this.updateLaunchGameButton(true);
    this.toggleLanguageSelector(false);

    try {
      this.resetState();

      const filesToUpdate = await invoke("get_files_to_update");

      if (filesToUpdate.length === 0) {
        this.setState({
          isUpdateAvailable: false,
          isFileCheckComplete: true,
          currentUpdateMode: "complete",
        });
        // Re-enable elements if no update is needed
        this.updateLaunchGameButton(false);
        this.toggleLanguageSelector(true);
        setTimeout(() => {
          this.setState({ currentUpdateMode: "ready" });
        }, 1000);
      } else {
        this.setState({
          isUpdateAvailable: true,
          isFileCheckComplete: true,
          currentUpdateMode: "complete",
          totalFiles: filesToUpdate.length,
          totalSize: filesToUpdate.reduce(
            (total, file) => total + file.size,
            0,
          ),
        });
        setTimeout(async () => {
          this.setState({ currentUpdateMode: "download" });
          await this.runPatchSystem(filesToUpdate);
        }, 2000);
      }
    } catch (error) {
      console.error("Error checking for updates:", error);
      this.resetState();
      this.showErrorMessage(this.t("UPDATE_SERVER_UNREACHABLE"));
      // Re-enable elements in case of error
      this.updateLaunchGameButton(false);
      this.toggleLanguageSelector(true);
    } finally {
      this.setState({ isCheckingForUpdates: false });
    }
  },

  /**
   * Runs the patch system to download and install updates.
   *
   * The method disables the game launch button and language selector at the start of the process, and
   * re-enables them at the end of the process. If no updates are needed, the method simply returns without
   * doing anything else. If an error occurs during the update process, the method shows an error message
   * and re-enables the game launch button and language selector.
   *
   * @param {Array.<FileInfo>} filesToUpdate - The list of files to update.
   *
   * @returns {Promise<void>}
   */
  async runPatchSystem(filesToUpdate) {
    if (!UPDATE_CHECK_ENABLED) {
      console.log("Updates are disabled, skipping patch system");
      return;
    }
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

      const downloadedSizes = await invoke("download_all_files", {
        filesToUpdate: filesToUpdate,
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
          downloadedSize: totalDownloadedSize,
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
            current_file_index: i + 1,
          },
        });

        lastUpdateTime = currentTime;
        lastDownloadedSize = totalDownloadedSize;
      }

      this.handleCompletion();
    } catch (error) {
      console.error("Error during update:", error);
      this.showErrorMessage(this.t("UPDATE_ERROR_MESSAGE"));
    } finally {
      // Re-enable the game launch button and language selector at the end of the process
      this.updateLaunchGameButton(false);
      this.toggleLanguageSelector(true);
    }
  },

  /**
   * Logs in to the game server using the given username and password.
   *
   * If a login attempt is already in progress, this function will not do anything.
   *
   * @param {string} username - The username to use for login
   * @param {string} password - The password to use for login
   *
   * @return {Promise<void>}
   */
  async login(username, password) {
    if (this.state.isLoggingIn) {
      console.log("A login attempt is already in progress.");
      return;
    }

    this.setState({ isLoggingIn: true });
    const loginButton = document.getElementById("login-button");
    const loginErrorMsg = document.getElementById("login-error-msg");

    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = this.t("LOGIN_IN_PROGRESS");
    }

    if (loginErrorMsg) {
      loginErrorMsg.style.display = "none";
      loginErrorMsg.style.opacity = 0;
    }

    try {
      console.log("invoke login from backend");
      const response = await invoke("login", { username, password });
      const jsonResponse = JSON.parse(response);

      if (
        jsonResponse &&
        jsonResponse.Return &&
        jsonResponse.Msg === "success"
      ) {
        this.storeAuthInfo(jsonResponse);
        console.log("Login success");

        if (!UPDATE_CHECK_ENABLED) {
          console.log(
            "Updates are disabled, skipping update check and server connection",
          );
          this.setState({
            isUpdateAvailable: false,
            isFileCheckComplete: true,
            currentUpdateMode: "complete",
            currentProgress: 100,
          });
          this.updateUI();
          await this.Router.navigate("home");
          return;
        }

        // Check server connection after successful login
        const isConnected = await this.checkServerConnection();
        if (isConnected) {
          console.log("Login success 2");
          await this.initializeAndCheckUpdates(true);
          await this.Router.navigate("home");
        } else {
          throw new Error(this.t("SERVER_CONNECTION_ERROR"));
        }
      } else {
        const errorMessage = jsonResponse
          ? jsonResponse.Msg || this.t("LOGIN_ERROR")
          : this.t("LOGIN_ERROR");
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error("Error during login:", error);
      if (loginErrorMsg) {
        loginErrorMsg.textContent =
          error.message || this.t("SERVER_CONNECTION_ERROR");
        loginErrorMsg.style.display = "flex";
        loginErrorMsg.style.opacity = 1;
      }
    } finally {
      this.setState({ isLoggingIn: false });
      if (loginButton) {
        loginButton.disabled = false;
        loginButton.textContent = this.t("LOGIN_BUTTON");
      }
    }
  },

  /**
   * Stores the authentication info in local storage and
   * informs the backend to set the authentication info
   * @param {Object} jsonResponse - The JSON response from the server
   * @param {string} jsonResponse.AuthKey - The authorization key
   * @param {string} jsonResponse.UserName - The username
   * @param {number} jsonResponse.UserNo - The user number
   * @param {string} jsonResponse.CharacterCount - The character count
   * @param {number} jsonResponse.Permission - The permission level
   * @param {number} jsonResponse.Privilege - The privilege level
   */
  storeAuthInfo(jsonResponse) {
    localStorage.setItem("authKey", jsonResponse.AuthKey);
    localStorage.setItem("userName", jsonResponse.UserName);
    localStorage.setItem("userNo", jsonResponse.UserNo.toString());
    localStorage.setItem(
      "characterCount",
      jsonResponse.CharacterCount.toString(),
    );
    localStorage.setItem("permission", jsonResponse.Permission.toString());
    localStorage.setItem("privilege", jsonResponse.Privilege.toString());

    invoke("set_auth_info", {
      authKey: jsonResponse.AuthKey,
      userName: jsonResponse.UserName,
      userNo: jsonResponse.UserNo,
      characterCount: jsonResponse.CharacterCount,
    });

    this.checkAuthentication();
  },

  /**
   * Navigates to the home page and initializes it
   *
   * @returns {Promise<void>}
   */
  async initializeHomePage() {
    this.Router.navigate("home");
    await this.waitForHomePage();
    await this.initHome();
  },

  /**
   * Waits until the home page is loaded and resolves the promise
   * @returns {Promise<void>}
   */
  waitForHomePage() {
    return new Promise((resolve) => {
      const checkDom = () => {
        if (document.getElementById("home-page")) {
          resolve();
        } else {
          setTimeout(checkDom, 100);
        }
      };
      checkDom();
    });
  },

  /**
   * Logs out the user and resets the state
   *
   * This method waits until a logout is not already in progress, then
   * sets the isLoggingOut state variable to true and calls the
   * backend's logout handler. After the logout is successful, it
   * removes all locally stored authentication information, resets
   * the state, and navigates to the login page.
   *
   * @returns {Promise<void>}
   */
  async logout() {
    if (this.state.isLoggingOut) {
      console.log("A logout is already in progress.");
      return;
    }

    this.setState({ isLoggingOut: true });
    try {
      await invoke("handle_logout");
      localStorage.removeItem("authKey");
      localStorage.removeItem("userName");
      localStorage.removeItem("userNo");
      localStorage.removeItem("characterCount");
      localStorage.removeItem("permission");
      localStorage.removeItem("privilege");

      this.setState({
        updateCheckPerformed: false,
        updateCheckPerformedOnLogin: false,
        updateCheckPerformedOnRefresh: false,
      });
      this.Router.navigate("login");
      this.resetState();
      this.checkAuthentication();
    } catch (error) {
      console.error("Error during logout:", error);
    } finally {
      this.setState({ isLoggingOut: false });
    }
  },

  /**
   * Changes the language used in the launcher to the given language and
   * updates the UI to reflect the new language.
   *
   * @param {string} newLang - The new language to use. Must be one of the
   *     keys in the languages object.
   *
   * @returns {Promise<void>}
   */
  async changeLanguage(newLang) {
    if (newLang !== this.currentLanguage) {
      this.currentLanguage = newLang;
      await invoke("save_language_to_config", {
        language: this.currentLanguage,
      });
      console.log(`Language saved to config: ${this.currentLanguage}`);

      await this.loadTranslations();
      await this.updateAllUIElements();

      const isGameRunning = await invoke("get_game_status");
      this.setState({ isGameRunning: isGameRunning });
    }
  },

  /**
   * Updates all UI elements to reflect the current state of the launcher. This
   * involves calling updateAllTranslations to update all the translations, and
   * then calling updateUI to update the actual UI elements.
   *
   * @returns {Promise<void>}
   */
  async updateAllUIElements() {
    await this.updateAllTranslations();
    this.updateUI();
  },

  /**
   * Updates the dynamic UI elements (i.e., the game status and the launch
   * game button) with the current translations.
   *
   * @returns {void}
   */
  updateDynamicTranslations() {
    if (this.statusEl) {
      this.statusEl.textContent = this.t(
        this.state.isGameRunning
          ? "GAME_STATUS_RUNNING"
          : "GAME_STATUS_NOT_RUNNING",
      );
    }
    if (this.launchGameBtn) {
      this.launchGameBtn.textContent = this.t("LAUNCH_GAME");
    }
  },

  /**
   * Enables or disables the language selector UI element, depending on the
   * value of the `enable` parameter. If `enable` is true, the language selector
   * will be enabled and the user will be able to select a language. If `enable`
   * is false, the language selector will be disabled and the user will not be
   * able to select a language.
   *
   * @param {boolean} enable If true, the language selector will be enabled.
   *                          If false, the language selector will be disabled.
   * @returns {void}
   */
  toggleLanguageSelector(enable) {
    const selectWrapper = document.querySelector(".select-wrapper");
    const selectStyled = selectWrapper?.querySelector(".select-styled");

    if (selectWrapper && selectStyled) {
      if (enable) {
        selectWrapper.classList.remove("disabled");
        selectStyled.style.pointerEvents = "auto";
      } else {
        selectWrapper.classList.add("disabled");
        selectStyled.style.pointerEvents = "none";
      }
    }
  },

  /**
   * Handles the game launch process. If updates are available, it prevents
   * the game from launching until the updates are applied. If the game is
   * already launching, it does nothing. Otherwise, it sets the game status
   * to "launching", subscribes to logs, creates a log modal, shows the log
   * modal, and initiates the game launch process by calling the
   * `handle_launch_game` command. If the game launch process fails, it sets
   * the game status to "not running" and resets the launch state.
   *
   * @returns {void}
   */
  async handleLaunchGame() {
    if (UPDATE_CHECK_ENABLED && this.state.isUpdateAvailable) {
      console.log(
        "Updates are available, please update before launching the game",
      );

      return;
    }
    if (this.state.isGameLaunching) {
      console.log("Game launch already in progress");
      return;
    }

    this.setState({ isGameLaunching: true });

    try {
      this.updateUIForGameStatus(true);
      if (this.statusEl) this.statusEl.textContent = this.t("LAUNCHING_GAME");

      await this.subscribeToLogs();

      console.log("Creating log modal");
      this.createLogModal();

      console.log("Attempting to show log modal");
      this.toggleModal("log-modal", true);

      // Check if the modal is visible
      const logModal = document.getElementById("log-modal");
      if (logModal) {
        console.log("Log modal display style:", logModal.style.display);
      } else {
        console.log("Log modal element not found");
      }

      const result = await invoke("handle_launch_game");
      console.log("Game launch result:", result);
    } catch (error) {
      console.error("Error initiating game launch:", error);
      const game_launch_error = this.t("GAME_LAUNCH_ERROR") + error.toString();

      await message(game_launch_error, {
        title: this.t("ERROR"),
        type: "error",
      });
      if (this.statusEl)
        this.statusEl.textContent = this.t(
          "GAME_LAUNCH_ERROR",
          error.toString(),
        );
      await invoke("reset_launch_state");
      this.updateUIForGameStatus(false);
      this.setState({ gameExecutionFailed: true });
    } finally {
      this.setState({ isGameLaunching: false });
    }
  },

  /**
   * Updates the game status UI based on the current game status.
   *
   * The game status is retrieved by invoking the "get_game_status" command.
   * If the command fails, an error is logged and the game status is set to
   * "GAME_STATUS_ERROR".
   *
   * @memberof App
   */
  async updateGameStatus() {
    try {
      const isRunning = await invoke("get_game_status");
      this.updateUIForGameStatus(isRunning);
    } catch (error) {
      console.error("Error checking game status:", error);
      if (this.statusEl)
        this.statusEl.textContent = this.t("GAME_STATUS_ERROR");
    }
  },

  /**
   * Updates the game status UI based on the current game status.
   *
   * The game status element is updated to either "GAME_STATUS_RUNNING" or "GAME_STATUS_NOT_RUNNING".
   * The launch game button is also updated to be enabled or disabled based on the game status.
   * The language selector is toggled to be visible or hidden based on the game status.
   *
   * @param {boolean} isRunning - whether the game is running or not
   * @memberof App
   */
  updateUIForGameStatus(isRunning) {
    if (this.statusEl) {
      this.statusEl.textContent = isRunning
        ? this.t("GAME_STATUS_RUNNING")
        : this.t("GAME_STATUS_NOT_RUNNING");
    }
    this.updateLaunchGameButton(isRunning);
    this.toggleLanguageSelector(!isRunning);
  },

  /**
   * Updates the launch game button UI based on the current game status.
   *
   * The launch game button is disabled or enabled based on the game status.
   * The "disabled" class is also toggled on the button based on the game status.
   *
   * @param {boolean} disabled - whether the game is running or not
   * @memberof App
   */
  updateLaunchGameButton(disabled) {
    if (this.launchGameBtn) {
      this.launchGameBtn.disabled = disabled;
      this.launchGameBtn.classList.toggle("disabled", disabled);
    }
  },

  /**
   * Updates the hash file generation progress UI based on the current game status.
   *
   * The hash file generation progress bar, current file being processed, and progress text are updated
   * based on the current game status. The modal title is also updated if necessary.
   *
   * @memberof App
   */
  updateHashFileProgressUI() {
    const modal = document.getElementById("hash-file-progress-modal");
    if (!modal || modal.style.display === "none") {
      return; // Ne pas mettre à jour si le modal n'est pas visible
    }

    const progressBar = modal.querySelector(".hash-progress-bar");
    const currentFileEl = modal.querySelector("#hash-file-current-file");
    const progressTextEl = modal.querySelector("#hash-file-progress-text");

    if (progressBar) {
      progressBar.style.width = `${this.state.hashFileProgress}%`;
      progressBar.textContent = `${Math.round(this.state.hashFileProgress)}%`;
    }

    if (currentFileEl) {
      const processingFileText = this.t("PROCESSING_FILE");
      currentFileEl.textContent = `${processingFileText}: ${this.state.currentProcessingFile}`;
    }

    if (progressTextEl) {
      const progressText = this.t("PROGRESS_TEXT");
      progressTextEl.textContent = `${progressText} ${this.state.processedFiles}/${this.state.totalFiles} (${this.state.hashFileProgress.toFixed(2)}%)`;
    }

    // Mettre à jour le titre du modal si nécessaire
    const modalTitle = modal.querySelector("h2");
    if (modalTitle) {
      modalTitle.textContent = this.t("GENERATING_HASH_FILE");
    }
  },

  /**
   * Checks if the game is currently running.
   *
   * @returns {Promise<boolean>} whether the game is running or not
   * @memberof App
   */
  async isGameRunning() {
    try {
      const isRunning = await invoke("get_game_status");
      return isRunning;
    } catch (error) {
      console.error("Error checking game status:", error);
      return false;
    }
  },

  /**
   * Checks if the server is currently reachable.
   *
   * @returns {Promise<boolean>} whether the server is reachable or not
   * @memberof App
   */
  async checkServerConnection() {
    console.log("Checking server connection");
    this.showLoadingModal(this.t("CHECKING_SERVER_CONNECTION"));
    try {
      const isConnected = await invoke("check_server_connection");
      this.hideLoadingModal();
      if (isConnected) {
        console.log("Server connection successful");
      } else {
        console.log("Server connection failed");
      }
      return isConnected;
    } catch (error) {
      console.error("Server connection error:", error);
      this.showLoadingError(this.t("SERVER_CONNECTION_ERROR"));
      return false;
    } finally {
      console.log("Server connection check complete");
    }
  },

  /**
   * Formats a given number of bytes into a human-readable size string.
   *
   * @param {number} bytes the number of bytes to format
   * @returns {string} the formatted size string
   * @memberof App
   */
  formatSize(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = parseFloat(bytes);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  },

  /**
   * Formats a given number of bytes per second into a human-readable speed string.
   *
   * @param {number} bytesPerSecond the number of bytes per second to format
   * @returns {string} the formatted speed string
   * @memberof App
   */
  formatSpeed(bytesPerSecond) {
    if (!isFinite(bytesPerSecond) || bytesPerSecond < 0) return "0 B/s";
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let speed = bytesPerSecond;
    let unitIndex = 0;
    while (speed >= 1024 && unitIndex < units.length - 1) {
      speed /= 1024;
      unitIndex++;
    }
    return `${speed.toFixed(2)} ${units[unitIndex]}`;
  },

  /**
   * Calculates the estimated time remaining for a download based on the total number of bytes downloaded so far, the total size of the download, and the current download speed.
   *
   * @param {number} totalDownloadedBytes the total number of bytes already downloaded
   * @param {number} totalSize the total size of the download in bytes
   * @param {number} speed the current download speed in bytes per second
   * @returns {number} the estimated time remaining in seconds, or 0 if the input is invalid. The result is capped at 30 days maximum.
   * @memberof App
   */
  calculateGlobalTimeRemaining(totalDownloadedBytes, totalSize, speed) {
    console.log("Calculating global time remaining:", {
      totalDownloadedBytes,
      totalSize,
      speed,
    });
    if (
      !isFinite(speed) ||
      speed <= 0 ||
      !isFinite(totalDownloadedBytes) ||
      !isFinite(totalSize) ||
      totalDownloadedBytes >= totalSize
    ) {
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

  /**
   * Format a time in seconds to a human-readable string.
   * If the input is invalid, returns 'Calculating...'
   * @param {number} seconds the time in seconds
   * @returns {string} a human-readable string representation of the time
   * @memberof App
   */
  formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "Calculating...";

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

  /**
   * Returns the file name from a given path, or an empty string if the path is invalid.
   * @param {string} path the path to get the file name from
   * @returns {string} the file name
   * @memberof App
   */
  getFileName(path) {
    return path ? path.split("\\").pop().split("/").pop() : "";
  },

  /**
   * Shows an error message in the #error-container element for 5 seconds.
   * If the element does not exist, does nothing.
   * @param {string} message the error message to display
   * @memberof App
   */
  showErrorMessage(message) {
    const errorContainer = document.getElementById("error-container");
    if (errorContainer) {
      errorContainer.textContent = message;
      errorContainer.style.display = "block";
      setTimeout(() => {
        errorContainer.style.display = "none";
      }, 5000);
    }
  },

  // Updated methods for loading modal
  showLoadingModal(message) {
    this.toggleModal("loading-modal", true, message);

    // Specific handling for loading modal elements
    if (this.loadingError) {
      this.loadingError.textContent = "";
      this.loadingError.style.display = "none";
    }
    if (this.refreshButton) {
      this.refreshButton.style.display = "none";
    }
    if (this.quitTheApp) {
      this.quitTheApp.style.display = "none";
    }
  },

  /**
   * Hides the loading modal.
   * @memberof App
   */
  hideLoadingModal() {
    this.toggleModal("loading-modal", false);
  },

  /**
   * Toggles the display of a modal.
   * @param {string} modalId The id of the modal to toggle.
   * @param {boolean} show Whether to show or hide the modal.
   * @param {string} [message] An optional message to display in the modal.
   * @memberof App
   */
  toggleModal(modalId, show, message = "") {
    const modal = document.getElementById(modalId);
    if (!modal) {
      console.error(`Modal with id ${modalId} not found`);
      return;
    }

    console.log(`Toggling modal ${modalId}, show: ${show}`);

    modal.classList.toggle("show", show);
    modal.style.display = show ? "block" : "none";

    // Handle message for loading modal
    if (modalId === "loading-modal" && message) {
      const messageElement = modal.querySelector(".loading-message");
      if (messageElement) {
        messageElement.textContent = message;
      }
    }

    console.log(
      `Modal ${modalId} visibility:`,
      modal.classList.contains("show"),
    );
  },

  /**
   * Toggles the display of the hash file progress modal.
   * @param {boolean} show Whether to show or hide the modal.
   * @param {string} [message] An optional message to display in the modal.
   * @param {boolean} [isComplete=false] Whether the hash file generation is complete.
   * If true, shows a success message and closes the modal after 5 seconds.
   * @memberof App
   */
  toggleHashProgressModal(show, message = "", isComplete = false) {
    const modal = document.getElementById("hash-file-progress-modal");
    if (!modal) {
      console.error("Hash file progress modal not found");
      return;
    }

    console.log(`Toggling hash progress modal, show: ${show}`);

    if (show) {
      modal.classList.add("show", "hash-modal-fade-in");
      modal.style.display = "block";

      // Handle message for hash file progress modal
      const messageElement = modal.querySelector("#hash-file-progress-text");
      if (messageElement && message) {
        messageElement.textContent = message;
      }

      if (isComplete) {
        // Show success message
        const successMessage = this.t("HASH_FILE_GENERATION_COMPLETE");
        const successElement = document.createElement("div");
        successElement.id = "hash-success-message";
        successElement.textContent = successMessage;

        const modalContent =
          modal.querySelector(".hash-progress-modal") || modal;
        modalContent.appendChild(successElement);

        // Wait 5 seconds, then close the modal
        setTimeout(() => {
          this.toggleHashProgressModal(false);
        }, 5000);
      }
    } else {
      modal.classList.remove("show", "hash-modal-fade-in");

      // Use a fade-out animation
      anime({
        targets: modal,
        opacity: 0,
        duration: 500,
        easing: "easeOutQuad",
        complete: () => {
          modal.style.display = "none";
          modal.style.opacity = 1; // Reset opacity for next time

          // Remove success message if it exists
          const successElement = modal.querySelector("#hash-success-message");
          if (successElement) {
            successElement.remove();
          }
        },
      });
    }

    console.log(
      `Hash progress modal visibility:`,
      modal.classList.contains("show"),
    );
  },

  //method to display the loading indicator
  showLoadingIndicator() {
    let loadingIndicator = document.getElementById("loading-indicator");
    if (!loadingIndicator) {
      loadingIndicator = document.createElement("div");
      loadingIndicator.id = "loading-indicator";
      loadingIndicator.innerHTML = '<div class="spinner"></div>';
      document.body.appendChild(loadingIndicator);
    }
    loadingIndicator.style.display = "flex";
  },

  //method to hide the loading indicator
  hideLoadingIndicator() {
    const loadingIndicator = document.getElementById("loading-indicator");
    if (loadingIndicator) {
      loadingIndicator.style.display = "none";
    }
  },

  /**
   * Shows the loading error message on the loading modal.
   * @param {string} errorMessage The error message to be displayed.
   */
  showLoadingError(errorMessage) {
    const loadingModal = document.getElementById("loading-modal");
    if (loadingModal) {
      const errorElement = loadingModal.querySelector(".loading-error");
      if (errorElement) {
        errorElement.textContent = errorMessage;
        errorElement.style.display = "block";
      }

      const refreshButton = loadingModal.querySelector("#refresh-button");
      if (refreshButton) {
        refreshButton.style.display = "inline-block";
      }

      const quitButton = loadingModal.querySelector("#quit-button");
      if (quitButton) {
        quitButton.style.display = "inline-block";
      }
    }
  },

  /**
   * Shows a notification at the top of the page.
   * @param {string} message The message to be displayed in the notification.
   * @param {string} type The type of the notification, which will be used to determine the
   * colour of the notification. Possible values are 'success' and 'error'.
   */
  showNotification(message, type) {
    const notification = document.getElementById("notification");
    if (notification) {
      notification.textContent = message;
      notification.className = `notification ${type}`;

      // Show the notification
      gsap.fromTo(
        notification,
        { opacity: 0, y: -20 },
        {
          duration: 0.5,
          opacity: 1,
          y: 0,
          display: "block",
          ease: "power2.out",
        },
      );

      // Hide the notification after 5 seconds
      gsap.to(notification, {
        delay: 5,
        duration: 0.5,
        opacity: 0,
        y: -20,
        display: "none",
        ease: "power2.in",
      });
    }
  },

  /**
   * Loads the translations from a JSON file named `translations.json` at the root of the
   * project. If any error occurs, it logs the error to the console and sets the
   * `translations` property to an empty object.
   *
   * @returns {Promise<void>}
   */
  async loadTranslations() {
    try {
      const response = await fetch("translations.json");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      this.translations = await response.json();
    } catch (error) {
      console.error("Error loading translations:", error);
      this.translations = { [this.currentLanguage]: {} };
    }
  },

  /**
   * Returns a translated string from the current language's translations.
   *
   * @param {string} key The key to translate.
   * @param {...*} args The arguments to replace in the translated string.
   * @returns {string} The translated string.
   */
  t(key, ...args) {
    const translations = this.translations[this.currentLanguage] || {};
    let str = translations[key] || key;
    return str.replace(/\{(\d+)\}/g, (_, index) => args[index] || "");
  },

  /**
   * Updates the language selector with the current language from the config file.
   * If any error occurs, it logs the error to the console and sets the
   * `currentLanguage` property to `'EUR'`.
   *
   * @returns {Promise<void>}
   */
  async updateLanguageSelector() {
    try {
      this.currentLanguage = await invoke("get_language_from_config");
      console.log(`Language loaded from config: ${this.currentLanguage}`);

      const selectWrapper = document.querySelector(".select-wrapper");
      const selectStyled = selectWrapper?.querySelector(".select-styled");
      const selectOptions = selectWrapper?.querySelector(".select-options");
      const originalSelect = selectWrapper?.querySelector("select");

      if (selectWrapper && selectStyled && selectOptions && originalSelect) {
        this.setupLanguageOptions(selectOptions, originalSelect);
        this.setupLanguageEventListeners(selectStyled, selectOptions);

        const currentLanguageName =
          this.languages[this.currentLanguage] || this.currentLanguage;
        selectStyled.textContent = currentLanguageName;
        originalSelect.value = this.currentLanguage;
      } else {
        console.warn("Language selector elements not found in the DOM");
      }

      await this.loadTranslations();
      await this.updateAllTranslations();
    } catch (error) {
      console.error("Error updating language selector:", error);
      this.currentLanguage = "EUR";
      await this.loadTranslations();
      await this.updateAllTranslations();
    }
  },

  /**
   * Sets up the language selector options based on the `this.languages` object.
   *
   * @param {HTMLElement} selectOptions - The `<ul>` element containing the language options.
   * @param {HTMLSelectElement} originalSelect - The `<select>` element containing the language options.
   * @returns {void}
   */
  setupLanguageOptions(selectOptions, originalSelect) {
    selectOptions.innerHTML = "";
    originalSelect.innerHTML = "";

    for (const [code, name] of Object.entries(this.languages)) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      originalSelect.appendChild(option);

      const li = document.createElement("li");
      li.setAttribute("rel", code);
      li.textContent = name;
      selectOptions.appendChild(li);
    }
  },

  /**
   * Sets up event listeners on the language selector options to change the language
   * when an option is clicked.
   *
   * @param {HTMLElement} selectStyled - The styled `<div>` element containing the selected language.
   * @param {HTMLElement} selectOptions - The `<ul>` element containing the language options.
   * @returns {void}
   */
  setupLanguageEventListeners(selectStyled, selectOptions) {
    selectOptions.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", async (e) => {
        const newLang = e.target.getAttribute("rel");
        if (newLang !== this.currentLanguage) {
          await this.changeLanguage(newLang);
          selectStyled.textContent = e.target.textContent;
        }
      });
    });
  },

  /**
   * Updates all elements with a `data-translate` attribute by setting their text
   * content to the translated value of the attribute's value. Also updates all
   * elements with a `data-translate-placeholder` attribute by setting their
   * `placeholder` attribute to the translated value of the attribute's value.
   *
   * This should be called after the language has been changed.
   *
   * @returns {Promise<void>}
   */
  async updateAllTranslations() {
    document.querySelectorAll("[data-translate]").forEach((el) => {
      const key = el.getAttribute("data-translate");
      el.textContent = this.t(key);
    });

    document.querySelectorAll("[data-translate-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-translate-placeholder");
      el.placeholder = this.t(key);
    });

    this.updateDynamicTranslations();
  },

  /**
   * Initializes the login page by adding an event listener to the login button.
   * When the button is clicked, the `login` function is called with the values
   * of the `username` and `password` input fields.
   *
   * @returns {void}
   */
  initLogin() {
    console.log("Initializing login page");
    const loginButton = document.getElementById("login-button");

    if (loginButton) {
      loginButton.addEventListener("click", async () => {
        console.log("Login button clicked");
        const username = document.getElementById("username").value;
        const password = document.getElementById("password").value;
        await this.login(username, password);
      });
    }
  },

  /**
   * Initializes the home page by creating a swiper slider and setting up the
   * home page elements and event listeners.
   *
   * @returns {Promise<void>}
   */
  async initHome() {
    const sliderContainer = document.querySelector(".slider-container");

    const swiper = new Swiper(".news-slider", {
      effect: "fade",
      fadeEffect: {
        crossFade: true,
      },
      speed: 1500,
      loop: true,
      autoplay: {
        delay: 5000,
        disableOnInteraction: false,
      },
      pagination: {
        el: ".swiper-pagination",
        clickable: true,
      },
      navigation: {
        nextEl: ".swiper-button-next",
        prevEl: ".swiper-button-prev",
      },
      on: {
        slideChangeTransitionStart: function () {
          sliderContainer.classList.add("pulse");
        },
        slideChangeTransitionEnd: function () {
          sliderContainer.classList.remove("pulse");
        },
      },
    });

    this.setupHomePageElements();
    this.setupHomePageEventListeners();
    await this.initializeHomePageComponents();
  },

  /**
   * Sets up the elements for the home page
   *
   * This is a one-time setup that should only be called once. It sets up the
   * elements that are used by the home page, such as the launch game button
   * and the game status element.
   *
   * @returns {void}
   */
  setupHomePageElements() {
    this.launchGameBtn = document.querySelector("#launch-game-btn");
    this.statusEl = document.querySelector("#game-status");
  },

  /**
   * Sets up the event listeners for the home page
   *
   * This method sets up the event listeners for the home page, such as the
   * launch game button, the logout button, the generate hash file button, and
   * the quit button.
   *
   * @returns {void}
   */
  setupHomePageEventListeners() {
    if (this.launchGameBtn) {
      this.launchGameBtn.addEventListener("click", () =>
        this.handleLaunchGame(),
      );
    }

    const logoutButton = document.getElementById("logout-link");
    if (logoutButton) {
      logoutButton.addEventListener("click", async (e) => {
        console.log("Logout button clicked");
        e.preventDefault();
        await this.logout();
      });
    }

    const generateHashFileBtn = document.getElementById("generate-hash-file");
    if (generateHashFileBtn && this.checkPrivilegeLevel()) {
      generateHashFileBtn.style.display = "block";
      generateHashFileBtn.addEventListener("click", () =>
        this.generateHashFile(),
      );
    }

    const appQuitButton = document.getElementById("app-quit");
    if (appQuitButton) {
      appQuitButton.addEventListener("click", () => this.appQuit());
    }
  },

  /**
   * Initializes the home page components
   *
   * This method initializes the components on the home page, such as the game
   * path, the user panel, the modal settings, and the game status. It also
   * updates the UI based on the user's privileges and the game status.
   *
   * @returns {Promise<void>}
   */
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
    const btnUserAvatar = document.querySelector(".btn-user-avatar");
    const dropdownPanelWrapper = document.querySelector(
      ".dropdown-panel-wrapper",
    );
    if (!btnUserAvatar || !dropdownPanelWrapper) {
      console.warn("User panel elements not found in the DOM");
      return;
    }

    // Initialize panel state
    let isPanelOpen = false;

    // Set up initial animation
    gsap.set(dropdownPanelWrapper, {
      display: "none",
      opacity: 0,
      y: -10,
    });

    // Create a reusable GSAP timeline
    const tl = gsap.timeline({ paused: true });
    tl.to(dropdownPanelWrapper, {
      duration: 0.3,
      display: "block",
      opacity: 1,
      y: 0,
      ease: "power2.out",
    });

    // Event handler for the button
    btnUserAvatar.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!isPanelOpen) {
        tl.play();
      } else {
        tl.reverse();
      }
      isPanelOpen = !isPanelOpen;
    });

    // Close panel when clicking outside
    document.addEventListener("click", () => {
      if (isPanelOpen) {
        tl.reverse();
        isPanelOpen = false;
      }
    });

    // Prevent closing when clicking inside the panel
    dropdownPanelWrapper.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    console.log("User panel initialized");
  },

  /**
   * Initializes the modal settings by finding the required elements in the DOM and
   * setting up event listeners for the button, close span, and input field.
   * @returns {void}
   */
  initModalSettings() {
    const modal = document.getElementById("modal");
    const btn = document.getElementById("openModal");
    const span = document.getElementsByClassName("close")[0];
    const input = document.getElementById("gameFolder");

    if (!modal || !btn || !span || !input) {
      console.warn("Modal elements not found in the DOM");
      return;
    }

    this.setupModalEventListeners(modal, btn, span, input);
  },

  /**
   * Sets up event listeners for the modal settings.
   * @param {HTMLElement} modal The modal element.
   * @param {HTMLElement} btn The button element that opens the modal.
   * @param {HTMLElement} span The close span element that closes the modal.
   * @param {HTMLElement} input The input field element for the game folder.
   * @returns {void}
   */
  setupModalEventListeners(modal, btn, span, input) {
    /**
     * Handles the click event for the game folder input field.
     *
     * Opens the file dialog to select a game folder, and if a folder is selected,
     * saves the path to the configuration file and shows a success notification.
     * If an error occurs, shows an error notification.
     * @returns {Promise<void>}
     */
    input.onclick = async () => {
      try {
        const selectedPath = await invoke("select_game_folder");
        if (selectedPath) {
          input.value = selectedPath;
          await this.saveGamePath(selectedPath);
          this.showNotification(this.t("FOLDER_SAVED_SUCCESS"), "success");
        }
      } catch (error) {
        console.error("Error selecting game folder:", error);
        this.showNotification(this.t("FOLDER_SELECTION_ERROR"), "error");
      }
    };

    /**
     * Handles the click event for the button that opens the modal.
     *
     * Animates the modal to open with a fade-in effect.
     * @returns {void}
     */
    btn.onclick = () => {
      gsap.to(modal, {
        duration: 0.5,
        display: "flex",
        opacity: 1,
        ease: "power2.inOut",
      });
    };

    span.onclick = () => this.closeModal(modal);

    /**
     * Handles the change event for the game folder input field.
     *
     * Checks if the new value contains the string "tera" (case-insensitive),
     * and shows a success notification if it does, or an error notification if it does not.
     * @returns {void}
     */
    input.onchange = () => {
      if (input.value.toLowerCase().includes("tera")) {
        this.showNotification(this.t("FOLDER_FOUND_SUCCESS"), "success");
      } else {
        this.showNotification(this.t("FOLDER_NOT_FOUND"), "error");
      }
    };

    /**
     * Handles the click event on the window.
     *
     * Checks if the target of the click event is the modal element,
     * and if so, calls the closeModal method to close the modal.
     * @param {MouseEvent} event The click event.
     * @returns {void}
     */
    window.onclick = (event) => {
      if (event.target == modal) {
        this.closeModal(modal);
      }
    };
  },

  /**
   * Closes the given modal element with a fade-out effect.
   *
   * Animates the modal to fade out with a duration of 0.5 seconds,
   * and once the animation is complete, sets the display property of the modal to "none".
   * @param {HTMLElement} modal The modal element to close.
   * @returns {void}
   */
  closeModal(modal) {
    gsap.to(modal, {
      duration: 0.5,
      opacity: 0,
      ease: "power2.inOut",
      /**
       * Sets the display property of the modal to "none" once the animation is complete.
       * This is necessary because the opacity animation does not affect the display property.
       * @this {GSAP}
       */
      onComplete: () => {
        modal.style.display = "none";
      },
    });
  },

  /**
   * Initializes the loading modal elements.
   *
   * Gets the loading modal, loading message, loading error, refresh button, and quit button elements
   * from the DOM. If any of these elements are not found, logs an error.
   * @memberof App
   * @returns {void}
   */
  initializeLoadingModalElements() {
    this.loadingModal = document.getElementById("loading-modal");
    if (this.loadingModal) {
      this.loadingMessage = this.loadingModal.querySelector(".loading-message");
      this.loadingError = this.loadingModal.querySelector(".loading-error");
      this.refreshButton = this.loadingModal.querySelector("#refresh-button");
      this.quitTheApp = this.loadingModal.querySelector("#quit-button");
    } else {
      console.error("Loading modal elements not found in the DOM");
    }
  },

  /**
   * Sets up event listeners for the refresh and quit buttons in the loading modal.
   *
   * If the refresh button is found, adds a click event listener that checks if the user
   * is connected to the internet and authenticated. If both conditions are true, calls
   * initializeAndCheckUpdates. If the quit button is found, adds a click event listener
   * that calls appQuit.
   * @memberof App
   * @returns {void}
   */
  setupModalButtonEventHandlers() {
    if (this.refreshButton) {
      this.refreshButton.addEventListener("click", async () => {
        const isConnected = await this.checkServerConnection();
        if (isConnected && this.state.isAuthenticated) {
          await this.initializeAndCheckUpdates();
        }
      });
    }
    if (this.quitTheApp) {
      this.quitTheApp.addEventListener("click", () => this.appQuit());
    }
  },

  /**
   * Creates the log modal if it doesn't exist and appends it to the body.
   * Otherwise, checks if the log modal exists and does nothing.
   * @memberof App
   * @returns {void}
   */
  createLogModal() {
    let modal = document.getElementById("log-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "log-modal";
      modal.innerHTML = `
                <div class="log-modal-content">
                    <div class="log-modal-header">
                        <h2>${this.t("GAME_LOGS")}</h2>
                        <span class="log-modal-close">&times;</span>
                    </div>
                    <div id="log-console"></div>
                </div>
            `;
      document.body.appendChild(modal);

      const closeBtn = modal.querySelector(".log-modal-close");
      closeBtn.onclick = () => this.toggleModal("log-modal", false);
    }
    console.log("Log modal created/checked");
  },

  /**
   * Appends a message to the log console.
   * @param {string} message The message to append. May contain a log level prefix.
   * @returns {void}
   */
  appendLogMessage(message) {
    const console = document.getElementById("log-console");
    const currentTime = Date.now();

    // Check if this exact message was logged in the last 100ms
    if (
      message === this.lastLogMessage &&
      currentTime - this.lastLogTime < 100
    ) {
      return; // Skip duplicate message
    }

    // Update last message and time
    this.lastLogMessage = message;
    this.lastLogTime = currentTime;

    if (console) {
      const logEntry = document.createElement("div");
      logEntry.className = "log-entry";
      const time = new Date().toLocaleTimeString();

      let logLevel = "info"; // Default log level
      let messageContent = message;
      const logLevels = ["INFO", "DEBUG", "WARN", "ERROR", "CRITICAL"];

      // Remove any leading log level from the message
      for (const level of logLevels) {
        if (messageContent.startsWith(level + ": ")) {
          messageContent = messageContent.substring(level.length + 2);
          break;
        }
      }

      // Detect log level
      for (const level of logLevels) {
        if (messageContent.startsWith(level + " -")) {
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

  /**
   * Subscribes to the "log_message" event and appends new log messages to the log console.
   * @returns {Promise<void>}
   */
  async subscribeToLogs() {
    console.log("Attempting to subscribe to logs");

    await listen("log_message", (event) => {
      //console.log("Received log message:", event.payload);
      this.appendLogMessage(event.payload);
    });

    console.log("Log subscription set up successfully");
  },

  /**
   * Saves the game path to the config file and handles the result based on first launch state.
   * @param {string} path - The path to the game executable.
   * @returns {Promise<void>}
   */
  async saveGamePath(path) {
    try {
      await invoke("save_game_path_to_config", { path });
      console.log("Game path saved successfully");
      if (this.state.isFirstLaunch) {
        this.completeFirstLaunch();
        this.showCustomNotification(
          this.t("GAME_PATH_SET_FIRST_LAUNCH"),
          "success",
        );
      } else {
        this.showCustomNotification(this.t("GAME_PATH_UPDATED"), "success");
      }
    } catch (error) {
      console.error("Error saving game path:", error);
      this.showCustomNotification(this.t("GAME_PATH_SAVE_ERROR"), "error");
      throw error;
    }
  },

  /**
   * Loads the game path from the config file and sets the input field value.
   * If an error occurs, it displays the error in a Windows system message and
   * offers the user the option to quit the app.
   */
  async loadGamePath() {
    try {
      const path = await invoke("get_game_path_from_config");
      const input = document.getElementById("gameFolder");
      if (input) {
        input.value = path;
      }
    } catch (error) {
      console.error("Error loading game path:", error);
      // Display the error in a Windows system message
      let errorMessage;
      if (
        error &&
        error.message &&
        typeof error.message === "string" &&
        error.message.toLowerCase().includes("tera_config.ini")
      ) {
        errorMessage = this.t("CONFIG_INI_MISSING");
      } else {
        errorMessage = `${this.t("GAME_PATH_LOAD_ERROR")} ${error && error ? error : ""}`;
      }

      const userResponse = await message(errorMessage, {
        title: this.t("ERROR"),
        type: "error",
      });

      if (userResponse) {
        this.appQuit();
      }
    }
  },

  /**
   * Sets up the event listeners for the window controls (minimize and close buttons)
   * to allow the user to interact with the window.
   */
  setupWindowControls() {
    const appMinimizeBtn = document.getElementById("app-minimize");
    if (appMinimizeBtn) {
      appMinimizeBtn.addEventListener("click", () => appWindow.minimize());
    }

    const appCloseBtn = document.getElementById("app-close");
    if (appCloseBtn) {
      appCloseBtn.addEventListener("click", () => this.appQuit());
    }
  },

  /**
   * Sets up the custom animations for the select element (dropdown menu) to give
   * it a nicer appearance. If the select element is not found, it does nothing.
   */
  setupCustomAnimations() {
    const selectWrapper = document.querySelector(".select-wrapper");
    if (selectWrapper) {
      const selectStyled = selectWrapper.querySelector(".select-styled");
      const selectOptions = selectWrapper.querySelector(".select-options");
      const originalSelect = selectWrapper.querySelector("select");

      if (selectStyled && selectOptions && originalSelect) {
        this.setupSelectAnimation(selectStyled, selectOptions, originalSelect);
      }
    }
  },

  /**
   * Sets up the custom animations for the select element (dropdown menu) to give
   * it a nicer appearance. If the select element is not found, it does nothing.
   * @param {HTMLElement} selectStyled The styled select element.
   * @param {HTMLElement} selectOptions The select options element.
   * @param {HTMLElement} originalSelect The original select element.
   */
  setupSelectAnimation(selectStyled, selectOptions, originalSelect) {
    selectStyled.addEventListener("click", (e) => {
      e.stopPropagation();
      selectStyled.classList.toggle("active");
      this.animateSelectOptions(selectOptions);
    });

    selectOptions.querySelectorAll("li").forEach((option) => {
      option.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handleSelectOptionClick(
          e.target,
          selectStyled,
          selectOptions,
          originalSelect,
        );
      });
    });

    document.addEventListener("click", () => {
      selectStyled.classList.remove("active");
      this.animateSelectOptions(selectOptions, true);
    });
  },

  /**
   * Animates the display of the select options element to give it a nicer
   * appearance. If the second argument is true, the element is hidden.
   * @param {HTMLElement} selectOptions The select options element.
   * @param {boolean} [hide=false] Whether to hide or show the element.
   */
  animateSelectOptions(selectOptions, hide = false) {
    anime({
      targets: selectOptions,
      opacity: hide ? [1, 0] : [0, 1],
      translateY: hide ? [0, -10] : [-10, 0],
      duration: 300,
      easing: "easeOutQuad",
      begin: (anim) => {
        if (!hide) selectOptions.style.display = "block";
      },
      complete: (anim) => {
        if (hide) selectOptions.style.display = "none";
      },
    });
  },

  /**
   * Handles a click on a select option by updating the displayed text on the
   * styled select element and hiding the options. Also animates the select
   * element to give it a nicer appearance.
   * @param {HTMLElement} target The option that was clicked.
   * @param {HTMLElement} selectStyled The styled select element.
   * @param {HTMLElement} selectOptions The select options element.
   * @param {HTMLSelectElement} originalSelect The original select element.
   */
  handleSelectOptionClick(target, selectStyled, selectOptions, originalSelect) {
    selectStyled.textContent = target.textContent;
    originalSelect.value = target.getAttribute("rel");
    selectStyled.classList.remove("active");
    this.animateSelectOptions(selectOptions, true);
    anime({
      targets: selectStyled,
      scale: [1, 1.05, 1],
      duration: 300,
      easing: "easeInOutQuad",
    });
  },

  /**
   * Sets up a mutation observer to detect changes to the 'dl-status-string'
   * element, which is used to display the download status of the game. When a
   * mutation is detected, the UI is updated to ensure that the displayed
   * information is correct.
   */
  setupMutationObserver() {
    const targetNode = document.getElementById("dl-status-string");
    if (targetNode) {
      const config = { childList: true, subtree: true };
      const callback = (mutationsList, observer) => {
        for (let mutation of mutationsList) {
          if (mutation.type === "childList") {
            console.log("Mutation detected in dl-status-string");
            this.updateUI();
          }
        }
      };
      this.observer = new MutationObserver(callback);
      this.observer.observe(targetNode, config);
    }
  },

  /**
   * Updates the visibility of the "Generate Hash File" button based on the current
   * privilege level. If the user has the required privilege level, the button is
   * displayed; otherwise, it is hidden.
   */
  updateUIBasedOnPrivileges() {
    const generateHashFileBtn = document.getElementById("generate-hash-file");
    if (generateHashFileBtn) {
      generateHashFileBtn.style.display = this.checkPrivilegeLevel()
        ? "block"
        : "none";
    }
  },

  /**
   * Checks if the user is authenticated by checking for the presence of a stored
   * authentication key in local storage. If the key is present, the user is
   * considered authenticated, otherwise they are not.
   */
  checkAuthentication() {
    this.setState({
      isAuthenticated: localStorage.getItem("authKey") !== null,
    });
  },

  /**
   * Checks if the user has the required privilege level by checking if the
   * 'privilege' key in local storage is a valid integer and greater than or
   * equal to the value of REQUIRED_PRIVILEGE_LEVEL.
   * @returns {boolean} True if the user has the required privilege level, false
   * otherwise.
   */
  checkPrivilegeLevel() {
    const userPrivilege = parseInt(localStorage.getItem("privilege"), 10);
    return !isNaN(userPrivilege) && userPrivilege >= REQUIRED_PRIVILEGE_LEVEL;
  },

  /**
   * Sends the stored authentication key, user name, user number, and character count
   * to the backend to set the auth info.
   * @returns {Promise<void>}
   */
  async sendStoredAuthInfoToBackend() {
    const authKey = localStorage.getItem("authKey");
    const userName = localStorage.getItem("userName");
    const userNo = parseInt(localStorage.getItem("userNo"), 10);
    const characterCount = localStorage.getItem("characterCount");

    if (authKey && userName && userNo && characterCount) {
      await invoke("set_auth_info", {
        authKey,
        userName,
        userNo,
        characterCount,
      });
    }
  },

  /**
   * Generates a hash file for the game files. If the operation is already in
   * progress, it will not start a new operation. It will disable the 'Generate
   * Hash File' button until the operation is complete. It will also show a
   * modal with a progress bar and show a notification when the operation is
   * complete or has failed.
   * @returns {Promise<void>}
   */
  async generateHashFile() {
    if (this.state.isGeneratingHashFile) {
      console.log("Hash file generation is already in progress");
      return;
    }

    try {
      this.setState({
        isGeneratingHashFile: true,
        hashFileProgress: 0,
        currentProcessingFile: "",
        processedFiles: 0,
        totalFiles: 0,
      });

      const generateHashBtn = document.getElementById("generate-hash-file");
      if (generateHashBtn) {
        generateHashBtn.disabled = true;
      }

      this.toggleHashProgressModal(
        true,
        this.t("INITIALIZING_HASH_GENERATION"),
      );

      const unlistenProgress = await listen("hash_file_progress", (event) => {
        const {
          current_file,
          progress,
          processed_files,
          total_files,
          total_size,
        } = event.payload;

        this.setState({
          hashFileProgress: progress,
          currentProcessingFile: current_file,
          processedFiles: processed_files,
          totalFiles: total_files,
        });

        this.updateHashFileProgressUI();
      });

      const result = await invoke("generate_hash_file");
      console.log("Hash file generation result:", result);
      this.toggleHashProgressModal(true, "", true);
      this.showNotification(this.t("HASH_FILE_GENERATED"), "success");
    } catch (error) {
      console.error("Error generating hash file:", error);
      this.showNotification(this.t("HASH_FILE_GENERATION_ERROR"), "error");
    } finally {
      this.setState({
        isGeneratingHashFile: false,
        hashFileProgress: 0,
        currentProcessingFile: "",
        processedFiles: 0,
        totalFiles: 0,
      });

      const generateHashBtn = document.getElementById("generate-hash-file");
      if (generateHashBtn) {
        generateHashBtn.disabled = false;
      }

      if (unlistenProgress) {
        unlistenProgress();
      }
    }
  },

  /**
   * Disable the context menu and text selection in the app window.
   *
   * This is needed to prevent users from selecting and copying text from the app window.
   * It's also needed to prevent users from accessing the context menu and doing things like
   * saving the page as a file, etc.
   */
  disableContextMenu() {
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });

    document.addEventListener("selectstart", (e) => {
      e.preventDefault();
    });
  },

  /**
   * Close the app window.
   *
   * This function is called when the app needs to be closed, such as when the user
   * clicks the "Exit" button in the app menu.
   */
  appQuit() {
    appWindow.close();
  },

  /**
   * Handles route changes.
   *
   * This function is called when a route change is detected. It simply calls
   * the Router's navigate method to handle the route change.
   */
  handleRouteChange() {
    console.log("Route change detected");
    this.Router.navigate();
  },

  /**
   * Loads the content of the specified file asynchronously.
   *
   * @param {string} file - The file to load the content of.
   *
   * @returns {Promise<string>} The loaded content as a string.
   */
  async loadAsyncContent(file) {
    console.log("Loading file:", file);
    const response = await fetch(file);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const content = await response.text();
    console.log("File loaded successfully");

    return content;
  },

  /**
   * Smoothly transitions between two pages.
   *
   * This function handles the process of smoothly transitioning between two
   * pages. It does this by animating the opacity and translateX properties of
   * the two pages. The new page is first appended to the app element, and then
   * the current page is removed once the animation is finished.
   *
   * @param {HTMLElement} app - The app element.
   * @param {HTMLElement} newPage - The new page element.
   */
  async smoothPageTransition(app, newPage) {
    const currentPage = app.querySelector(".page");

    newPage.style.position = "absolute";
    newPage.style.top = "0";
    newPage.style.left = "0";
    newPage.style.width = "100%";
    newPage.style.opacity = "0";
    newPage.style.transform = "translateX(20px)";

    app.appendChild(newPage);

    if (currentPage) {
      await anime({
        targets: currentPage,
        opacity: [1, 0],
        translateX: [0, -20],
        easing: "easeInOutQuad",
        duration: 300,
      }).finished;

      currentPage.remove();
    }

    await anime({
      targets: newPage,
      opacity: [0, 1],
      translateX: [20, 0],
      easing: "easeOutQuad",
      duration: 300,
    }).finished;

    newPage.style.position = "";
    newPage.style.top = "";
    newPage.style.left = "";
    newPage.style.width = "";
    newPage.style.transform = "";
  },
};

// Create the Router and attach it to App
App.Router = createRouter(App);

// Expose App globally if necessary
window.App = App;

// Initialize the app when the DOM is fully loaded
window.addEventListener("DOMContentLoaded", () => App.init());

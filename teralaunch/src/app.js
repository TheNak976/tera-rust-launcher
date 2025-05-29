const { invoke } = window.__TAURI__.tauri;
const { listen } = window.__TAURI__.event;
const { appWindow } = window.__TAURI__.window;
const { message } = window.__TAURI__.dialog;

import {
  formatSize,
  formatSpeed,
  calculateGlobalTimeRemaining,
  calculateAverageSpeed,
  formatTime,
  getFileName,
} from "./utils.js";
import { createUI } from "./ui.js";

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
  deferredUpdate: null,
  ui: null, // UI module will be initialized here

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
      // Initialize UI module early, as other initializations might depend on it
      // Passing 'this' (App) as the last argument for ui to call App methods if needed.
      this.ui = createUI(this.state, this.t.bind(this), invoke, appWindow, message, this.Router, this);

      this.disableContextMenu();
      this.setupEventListeners();
      this.setupWindowControls();
      this.setupCustomAnimations();
      // initializeLoadingModalElements() and setupModalButtonEventHandlers() are now called within ui.initElements()
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
      if (this.ui) this.ui.updateUIForGameStatus(isRunning);
    });

    listen("game_status_changed", (event) => {
      const isRunning = event.payload;
      if (this.ui) this.ui.updateUIForGameStatus(isRunning);
    });

    listen("game_ended", () => {
      console.log("Game has ended");
      if (this.ui) {
        this.ui.updateUIForGameStatus(false);
        this.ui.toggleModal("log-modal", false);
      }
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
      if (this.ui) this.ui.showErrorMessage(event.payload);
    });
  },

  // Function to handle the first launch
  async handleFirstLaunch() {
    console.log("First time launch detected");
    if (this.ui) this.ui.showFirstLaunchModal(); // This method will be moved to ui.js
  },

  // Function to show a custom modal for first launch - MOVED TO UI.JS
  // showFirstLaunchModal() { ... }

  // Function to close the first launch modal - MOVED TO UI.JS
  // closeFirstLaunchModal() { ... }

  // Function to open game path settings - REMAINS IN APP FOR NOW
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

  // Function for custom notifications - MOVED TO UI.JS
  // showCustomNotification(message, type) { ... }

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
    const timeRemaining = calculateGlobalTimeRemaining(
      totalDownloadedBytes,
      this.state.totalSize,
      speed,
      this.state.speedHistory,
      this.state.speedHistoryMaxLength,
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
        if (this.ui) this.ui.updateUIElements(); // This method is now in ui.js
        this.deferredUpdate = null;
      });
    }
  },

  // updateUIElements, updateTextContents, updateProgressBar, updateDownloadInfo,
  // getDlStatusString, calculateProgress, getStatusText, updateElementsVisibility
  // are now defined in ui.js and will be removed from App.
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
      if (this.ui) this.ui.updateLaunchGameButton(false); // This method will be moved to ui.js
      if (this.ui) this.ui.toggleLanguageSelector(true); // This method will be moved to ui.js
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
    if (this.ui) this.ui.updateLaunchGameButton(true);
    if (this.ui) this.ui.toggleLanguageSelector(false);

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
        if (this.ui) this.ui.updateLaunchGameButton(false);
        if (this.ui) this.ui.toggleLanguageSelector(true);
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
      if (this.ui) this.ui.showErrorMessage(this.t("UPDATE_SERVER_UNREACHABLE"));
      // Re-enable elements in case of error
      if (this.ui) this.ui.updateLaunchGameButton(false);
      if (this.ui) this.ui.toggleLanguageSelector(true);
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
      if (this.ui) this.ui.updateLaunchGameButton(true);
      if (this.ui) this.ui.toggleLanguageSelector(false);

      if (filesToUpdate.length === 0) {
        console.log("No update needed");
        // Re-enable elements if no update is needed
        if (this.ui) this.ui.updateLaunchGameButton(false);
        if (this.ui) this.ui.toggleLanguageSelector(true);
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
      if (this.ui) this.ui.showErrorMessage(this.t("UPDATE_ERROR_MESSAGE"));
    } finally {
      // Re-enable the game launch button and language selector at the end of the process
      if (this.ui) this.ui.updateLaunchGameButton(false);
      if (this.ui) this.ui.toggleLanguageSelector(true);
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

  // updateDynamicTranslations is now in ui.js
  // toggleLanguageSelector is now in ui.js
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
      if (this.ui) this.ui.updateUIForGameStatus(true);
      if (this.ui && this.ui.statusEl) this.ui.statusEl.textContent = this.t("LAUNCHING_GAME");

      await this.subscribeToLogs(); // subscribeToLogs uses ui.appendLogMessage

      console.log("Creating log modal");
      if (this.ui) this.ui.createLogModal();

      console.log("Attempting to show log modal");
      if (this.ui) this.ui.toggleModal("log-modal", true);

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
      if (this.ui && this.ui.statusEl)
        this.ui.statusEl.textContent = this.t(
          "GAME_LAUNCH_ERROR",
          error.toString(),
        );
      await invoke("reset_launch_state");
      if (this.ui) this.ui.updateUIForGameStatus(false);
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
      if (this.ui) this.ui.updateUIForGameStatus(isRunning); // Call to ui method
    } catch (error) {
      console.error("Error checking game status:", error);
      if (this.ui && this.ui.statusEl) // Check ui and element exists
        this.ui.statusEl.textContent = this.t("GAME_STATUS_ERROR");
    }
  },

  // updateUIForGameStatus (App object's own version) is now removed (moved to ui.js)
  // updateLaunchGameButton (App object's own version) is now removed (moved to ui.js)
  // updateHashFileProgressUI is now in ui.js
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
    if (this.ui) this.ui.showLoadingModal(this.t("CHECKING_SERVER_CONNECTION"));
    try {
      const isConnected = await invoke("check_server_connection");
      if (this.ui) this.ui.hideLoadingModal();
      if (isConnected) {
        console.log("Server connection successful");
      } else {
        console.log("Server connection failed");
      }
      return isConnected;
    } catch (error) {
      console.error("Server connection error:", error);
      if (this.ui) this.ui.showLoadingError(this.t("SERVER_CONNECTION_ERROR"));
      return false;
    } finally {
      console.log("Server connection check complete");
    }
  },

  // Definitions of showErrorMessage, showLoadingModal, hideLoadingModal, toggleModal, 
  // toggleHashProgressModal, showLoadingIndicator, hideLoadingIndicator, showLoadingError, 
  // showNotification, createLogModal, appendLogMessage, closeModal, 
  // initializeLoadingModalElements, setupModalButtonEventHandlers, and showCustomNotification (definition)
  // are removed as they are now in ui.js. Calls were updated in previous steps.

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
  // initializeLoadingModalElements, setupModalButtonEventHandlers, createLogModal, appendLogMessage
  // are now part of ui.js

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
        if (this.ui) this.ui.showCustomNotification(
          this.t("GAME_PATH_SET_FIRST_LAUNCH"),
          "success",
        );
      } else {
        if (this.ui) this.ui.showCustomNotification(this.t("GAME_PATH_UPDATED"), "success");
      }
    } catch (error) {
      console.error("Error saving game path:", error);
      if (this.ui) this.ui.showCustomNotification(this.t("GAME_PATH_SAVE_ERROR"), "error");
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
  // updateUIBasedOnPrivileges is moved to ui.js
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

      if (this.ui) this.ui.toggleHashProgressModal(
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
      if (this.ui) this.ui.toggleHashProgressModal(true, "", true);
      if (this.ui) this.ui.showNotification(this.t("HASH_FILE_GENERATED"), "success");
    } catch (error) {
      console.error("Error generating hash file:", error);
      if (this.ui) this.ui.showNotification(this.t("HASH_FILE_GENERATION_ERROR"), "error");
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

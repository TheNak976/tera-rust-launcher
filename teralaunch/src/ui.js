// ui.js
// Assuming Anime.js and GSAP are globally available.
// If not, they would need to be imported:
// import anime from 'animejs';
// import gsap from 'gsap';

export function createUI(t, App_reference) { 
    const ui = {
        // Cached elements
        loadingModal: null,
        loadingMessage: null,
        loadingError: null,
        refreshButton: null,
        quitTheApp: null,
        
        // For appendLogMessage state
        lastLogMessage: null,
        lastLogTime: 0,

        initializeLoadingModalElements() {
            this.loadingModal = document.getElementById("loading-modal");
            if (this.loadingModal) {
                this.loadingMessage = this.loadingModal.querySelector(".loading-message");
                this.loadingError = this.loadingModal.querySelector(".loading-error");
                this.refreshButton = this.loadingModal.querySelector("#refresh-button");
                this.quitTheApp = this.loadingModal.querySelector("#quit-button");
            } else {
                // Using console.warn to be less disruptive if modal isn't always in DOM
                console.warn("Loading modal elements not found in the DOM during ui.initializeLoadingModalElements");
            }
        },

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

        toggleModal(modalId, show, message = "") {
            const modal = document.getElementById(modalId);
            if (!modal) {
                console.error(`Modal with id ${modalId} not found`);
                return;
            }
            modal.classList.toggle("show", show);
            modal.style.display = show ? "block" : "none";

            if (modalId === "loading-modal" && message && this.loadingMessage) {
                this.loadingMessage.textContent = message;
            }
        },
        
        showLoadingModal(message) {
            this.toggleModal("loading-modal", true, message);
            // Specific handling for loading modal elements, ensuring they are cached
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

        hideLoadingModal() {
            this.toggleModal("loading-modal", false);
        },

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

        hideLoadingIndicator() {
            const loadingIndicator = document.getElementById("loading-indicator");
            if (loadingIndicator) {
                loadingIndicator.style.display = "none";
            }
        },

        showLoadingError(errorMessage) {
            // Assumes loadingModal elements are initialized via initializeLoadingModalElements
            if (this.loadingModal) { // Check if loadingModal itself is cached
                if (this.loadingError) {
                    this.loadingError.textContent = errorMessage;
                    this.loadingError.style.display = "block";
                }
                if (this.refreshButton) {
                    this.refreshButton.style.display = "inline-block";
                }
                if (this.quitTheApp) { 
                    this.quitTheApp.style.display = "inline-block";
                }
            }
        },

        showNotification(message, type) {
            const notification = document.getElementById("notification");
            if (notification) {
                notification.textContent = message;
                notification.className = `notification ${type}`;
                // Assumes gsap is global
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

        showCustomNotification(message, type) {
            const notification = document.createElement("div");
            notification.className = `custom-notification ${type}`;
            notification.textContent = message;
            document.body.appendChild(notification);
            // Assumes anime is global
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
        
        closeModal(modalElement) { 
            // Assumes gsap is global
            gsap.to(modalElement, { 
                duration: 0.5,
                opacity: 0,
                ease: "power2.inOut",
                onComplete: () => {
                    if (modalElement) { // Check if modalElement still exists before trying to change its style
                        modalElement.style.display = "none";
                    }
                },
            });
        },

        createLogModal() {
            let modal = document.getElementById("log-modal");
            if (!modal) {
                modal = document.createElement("div");
                modal.id = "log-modal";
                modal.innerHTML = `
                    <div class="log-modal-content">
                        <div class="log-modal-header">
                            <h2>${t("GAME_LOGS")}</h2> 
                            <span class="log-modal-close">&times;</span>
                        </div>
                        <div id="log-console"></div>
                    </div>
                `;
                document.body.appendChild(modal);
                const closeBtn = modal.querySelector(".log-modal-close");
                if(closeBtn) { // Ensure closeBtn is found
                    closeBtn.onclick = () => this.toggleModal("log-modal", false); 
                }
            }
        },

        appendLogMessage(messageText) {
            const consoleEl = document.getElementById("log-console");
            const currentTime = Date.now();

            if (messageText === this.lastLogMessage && currentTime - this.lastLogTime < 100) {
                return; 
            }
            this.lastLogMessage = messageText;
            this.lastLogTime = currentTime;

            if (consoleEl) {
                const logEntry = document.createElement("div");
                logEntry.className = "log-entry";
                const time = new Date().toLocaleTimeString();
                let logLevel = "info"; 
                let messageContent = messageText;
                const logLevels = ["INFO", "DEBUG", "WARN", "ERROR", "CRITICAL"]; // Make sure this list is comprehensive
                for (const level of logLevels) {
                    if (messageContent.startsWith(level + ": ")) {
                        messageContent = messageContent.substring(level.length + 2);
                        break;
                    }
                }
                for (const level of logLevels) {
                    if (messageContent.startsWith(level + " -")) { // Check for "LEVEL -" pattern
                        logLevel = level.toLowerCase();
                        messageContent = messageContent.substring(level.length + 2).trim();
                        break;
                    }
                }
                logEntry.innerHTML = `
                    <span class="log-entry-time">[${time}]</span>
                    <span class="log-entry-level ${logLevel}">${logLevel.toUpperCase()}:</span>
                    <span class="log-entry-message">${messageContent}</span>`; // Ensure messageContent is properly escaped if it can contain HTML
                consoleEl.appendChild(logEntry);
                consoleEl.scrollTop = consoleEl.scrollHeight;
            }
        },

        toggleHashProgressModal(show, messageText = "", isComplete = false) {
            const modal = document.getElementById("hash-file-progress-modal");
            if (!modal) { console.error("Hash file progress modal not found"); return; }

            if (show) {
                modal.classList.add("show", "hash-modal-fade-in");
                modal.style.display = "block";
                const messageElement = modal.querySelector("#hash-file-progress-text");
                if (messageElement && messageText) messageElement.textContent = messageText;

                if (isComplete) {
                    const successMessage = t("HASH_FILE_GENERATION_COMPLETE");
                    const successElement = document.createElement("div");
                    successElement.id = "hash-success-message";
                    successElement.textContent = successMessage;
                    const modalContent = modal.querySelector(".hash-progress-modal") || modal;
                    modalContent.appendChild(successElement);
                    setTimeout(() => { this.toggleHashProgressModal(false); }, 5000);
                }
            } else {
                modal.classList.remove("show", "hash-modal-fade-in");
                // Assumes anime is global
                anime({ 
                    targets: modal, opacity: 0, duration: 500, easing: "easeOutQuad",
                    complete: () => {
                        if (modal) { // Check modal still exists
                           modal.style.display = "none"; modal.style.opacity = 1; // Reset opacity for next time
                        }
                        const successElement = document.getElementById("hash-success-message"); // Query globally or from modal
                        if (successElement && successElement.parentNode) {
                           successElement.parentNode.removeChild(successElement);
                        }
                    },
                });
            }
        }
    };

    ui.initializeLoadingModalElements();
    return ui;
}

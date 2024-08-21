/**
 * Router object responsible for handling navigation and route management.
 */
const createRouter = (App) => ({
    routes: {
        home: {
            title: 'Home',
            file: 'home.html',
            protected: true,
            init: 'initHome'
        },
        login: {
            title: 'Login',
            file: 'login.html',
            public: true,
            init: 'initLogin'
        }
    },

    currentRoute: null,
    isTransitioning: false,

    /**
     * Navigates to the specified route or handles the current URL hash.
     * @param {string|null} route - The route to navigate to, or null to use the current hash.
     */
    async navigate(route = null) {
        if (this.isTransitioning) {
            console.log('Transition already in progress, ignoring');
            return;
        }

        this.isTransitioning = true;

        try {
            const app = document.getElementById('app');
            route = await this.determineRoute(route);

            if (!route) {
                this.isTransitioning = false;
                return;
            }

            if (!this.isRouteValid(route)) {
                this.handleInvalidRoute(app);
                return;
            }

            await this.handleRouteTransition(app, route);
        } catch (error) {
            console.error('Error during routing:', error);
            this.handleRoutingError();
        } finally {
            this.isTransitioning = false;
        }
    },
    
    /**
     * Determines the appropriate route based on authentication status and current state.
     * @param {string|null} route - The initially requested route.
     * @returns {string|null} The determined route or null if navigation should be cancelled.
     */
    async determineRoute(route) {
        route = route || window.location.hash.replace('#', '') || 'home';
        console.log('Requested route:', route);

        // Check authentication asynchronously
        await App.checkAuthentication();

        if (this.routes[route].protected && !App.state.isAuthenticated) {
            console.log('Route is protected and user is not authenticated, redirecting to login');
            return 'login';
        }

        if (route === 'login' && App.state.isAuthenticated) {
            console.log('User is already authenticated, redirecting to home');
            return 'home';
        }

        if (this.currentRoute === route) {
            console.log('Already on this route, ignoring');
            return null;
        }

        return route;
    },

    /**
     * Checks if the given route exists in the defined routes.
     * @param {string} route - The route to validate.
     * @returns {boolean} True if the route is valid, false otherwise.
     */
    isRouteValid(route) {
        return this.routes[route] !== undefined;
    },

    handleInvalidRoute(app) {
        console.log('Route not found:', route);
        app.innerHTML = `<div class="page"><h1>${App.t('PAGE_NOT_FOUND')}</h1></div>`;
    },

    /**
     * Handles the transition to a new route, including content loading and page updates.
     * @param {HTMLElement} app - The main application container element.
     * @param {string} route - The route to transition to.
     */
    async handleRouteTransition(app, route) {
        document.title = this.routes[route].title;

        App.showLoadingIndicator();

        const content = await this.loadRouteContent(route);
        await this.simulateLoadingDelay();

        const newPage = this.createNewPage(content);

        App.hideLoadingIndicator();

        await App.smoothPageTransition(app, newPage);

        this.updateUserInfo(newPage);

        this.updateCurrentRoute(route);

        await this.initializeNewRoute(route);

        await App.updateAllTranslations();
    },

    /**
     * Loads the content for the specified route.
     * @param {string} route - The route to load content for.
     * @returns {Promise<string>} The loaded content as a string.
     */
    async loadRouteContent(route) {
        console.log('Loading content for route:', route);
        const content = await App.loadAsyncContent(this.routes[route].file);
        console.log('Content loaded:', content.substring(0, 100) + '...');
        return content;
    },

    async simulateLoadingDelay() {
        await new Promise(resolve => setTimeout(resolve, 500));
    },

    /**
     * Creates a new page element with the given content.
     * @param {string} content - The HTML content for the new page.
     * @returns {HTMLElement} The newly created page element.
     */
    createNewPage(content) {
        const newPage = document.createElement('div');
        newPage.className = 'page';
        newPage.innerHTML = content;
        return newPage;
    },

    updateUserInfo(newPage) {
        if (App.state.isAuthenticated) {
            const userNameEl = newPage.querySelector('#userName');
            if (userNameEl) userNameEl.textContent = localStorage.getItem('userName');
        }
    },

    /**
     * Updates the current route and syncs it with the URL hash.
     * @param {string} route - The new current route.
     */
    updateCurrentRoute(route) {
        this.currentRoute = route;

        if (window.location.hash !== `#${route}`) {
            window.location.hash = route;
        }
    },

    /**
     * Initializes the new route by calling its associated init function if defined.
     * @param {string} route - The route to initialize.
     */
    async initializeNewRoute(route) {
        if (this.routes[route].init) {
            console.log('Initializing route:', route);
            await App[this.routes[route].init]();
        }
    },

    handleRoutingError() {
        const app = document.getElementById('app');
        app.innerHTML = `<div class="page"><h1>${App.t('LOADING_ERROR')}</h1></div>`;
        App.hideLoadingIndicator();
    },

    /**
     * Sets up event listeners for hash changes to trigger navigation.
     */
    setupEventListeners() {
        window.addEventListener('hashchange', () => this.navigate());
    }
});
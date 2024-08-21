use std::sync::Arc;
use parking_lot::RwLock;
use lazy_static::lazy_static;

/// ThreadSafeCredentials provides a thread-safe way to store and access
/// game credentials (account name, ticket, characters_count and game language).
pub struct ThreadSafeCredentials {
    account_name: Arc<RwLock<String>>,
    characters_count: Arc<RwLock<String>>,
    ticket: Arc<RwLock<String>>,
    game_lang: Arc<RwLock<String>>,
    game_path: Arc<RwLock<String>>
}

impl ThreadSafeCredentials {
    /// Creates a new instance of ThreadSafeCredentials with empty strings.
    fn new() -> Self {
        Self {
            account_name: Arc::new(RwLock::new(String::new())),
            characters_count: Arc::new(RwLock::new(String::new())),
            ticket: Arc::new(RwLock::new(String::new())),
            game_lang: Arc::new(RwLock::new(String::new())),
            game_path: Arc::new(RwLock::new(String::new())),
        }
    }

    /// Sets the account name.
    ///
    /// This method acquires a write lock on the account_name field,
    /// which may block if there are current readers.
    ///
    /// # Arguments
    ///
    /// * `value` - A string slice that holds the account name to be set.
    pub fn set_account_name(&self, value: &str) {
        *self.account_name.write() = value.to_string();
    }

    /// Sets the characters_count.
    ///
    /// This method acquires a write lock on the characters_count field,
    /// which may block if there are current readers.
    ///
    /// # Arguments
    ///
    /// * `value` - A string slice that holds the characters_count to be set.
    pub fn set_characters_count(&self, value: &str) {
        *self.characters_count.write() = value.to_string();
    }


    /// Sets the ticket (GUID).
    ///
    /// This method acquires a write lock on the ticket field,
    /// which may block if there are current readers.
    ///
    /// # Arguments
    ///
    /// * `value` - A string slice that holds the ticket (GUID) to be set.
    pub fn set_ticket(&self, value: &str) {
        *self.ticket.write() = value.to_string();
    }

    /// Sets the game language.
    ///
    /// This method acquires a write lock on the game_lang field,
    /// which may block if there are current readers.
    ///
    /// # Arguments
    ///
    /// * `value` - A string slice that holds the game language to be set.
    pub fn set_game_lang(&self, value: &str) {
        *self.game_lang.write() = value.to_string();
    }

    /// Sets the game path.
    ///
    /// This method acquires a write lock on the game_path field,
    /// which may block if there are current readers.
    ///
    /// # Arguments
    ///
    /// * `value` - A string slice that holds the game path to be set.
    pub fn set_game_path(&self, value: &str) {
        *self.game_path.write() = value.to_string();
    }

    //////////////////////////////////////////////////////////////////////


    /// Gets the account name.
    ///
    /// This method acquires a read lock on the account_name field,
    /// which allows for multiple concurrent readers.
    ///
    /// # Returns
    ///
    /// A String containing the current account name.
    pub fn get_account_name(&self) -> String {
        self.account_name.read().clone()
    }

    /// Gets the account characters.
    ///
    /// This method acquires a read lock on the characters_count field,
    /// which allows for multiple concurrent readers.
    ///
    /// # Returns
    ///
    /// A String containing the current characters_count.
    pub fn get_characters_count(&self) -> String {
        self.characters_count.read().clone()
    }


    /// Gets the ticket (GUID).
    ///
    /// This method acquires a read lock on the ticket field,
    /// which allows for multiple concurrent readers.
    ///
    /// # Returns
    ///
    /// A String containing the current ticket (GUID).
    pub fn get_ticket(&self) -> String {
        self.ticket.read().clone()
    }

    /// Gets the game language.
    ///
    /// This method acquires a read lock on the game_lang field,
    /// which allows for multiple concurrent readers.
    ///
    /// # Returns
    ///
    /// A String containing the current game language.
    pub fn get_game_lang(&self) -> String {
        self.game_lang.read().clone()
    }


    /// Gets the game path.
    ///
    /// This method acquires a read lock on the game_path field,
    /// which allows for multiple concurrent readers.
    ///
    /// # Returns
    ///
    /// A String containing the current game path.
    pub fn get_game_path(&self) -> String {
        self.game_path.read().clone()
    }

}


lazy_static! {
    #[doc = "GLOBAL_CREDENTIALS is a lazily-initialized static reference to ThreadSafeCredentials."]
    #[doc = "It's used to store and access game credentials globally across the application."]
    pub static ref GLOBAL_CREDENTIALS: ThreadSafeCredentials = ThreadSafeCredentials::new();
}

/// Sets all credentials at once.
///
/// This function is a convenience wrapper that sets all three credential fields
/// (account name, ticket, and game language) in one call.
///
/// # Arguments
///
/// * `account_name` - A string slice that holds the account name to be set.
/// * `ticket` - A string slice that holds the ticket (GUID) to be set.
/// * `game_lang` - A string slice that holds the game language to be set.
pub fn set_credentials(account_name: &str, characters_count: &str, ticket: &str, game_lang: &str, game_path: &str) {
    GLOBAL_CREDENTIALS.set_account_name(account_name);
    GLOBAL_CREDENTIALS.set_characters_count(characters_count);
    GLOBAL_CREDENTIALS.set_ticket(ticket);
    GLOBAL_CREDENTIALS.set_game_lang(game_lang);
    GLOBAL_CREDENTIALS.set_game_path(game_path);
}
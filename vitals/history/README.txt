This folder is where VITALS writes everything it learns about the machine it is running on:
telemetry history, the event journal, the outcomes ledger and the Ask conversation.

Your API key and admin passphrase are NOT in here - they live in %LOCALAPPDATA%\vitals (or
~/.local/share/vitals), outside the install folder, so that clearing this folder cannot be
mistaken for clearing your credentials.

It ships empty of MACHINE DATA on purpose. The only thing in here is procsamples/ - a handful of
captured Linux /proc files that the collector test suite reads.

If you are moving an install between machines, do not copy this folder across - it is the
previous machine's record, not the product.

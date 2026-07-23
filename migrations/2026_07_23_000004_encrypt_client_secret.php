<?php

use Illuminate\Support\Facades\Crypt;
use Illuminate\Database\Migrations\Migration;
use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary as BlueprintExtensionLibrary;

/**
 * One-time upgrade: Blueprint's dbSet()/dbGet() only serialize values, they
 * don't encrypt them, so client_secret has been sitting in the `settings`
 * table in plain text. This encrypts whatever's currently stored (if
 * anything) using Laravel's APP_KEY-based Crypt facade - a no-op if it's
 * somehow already encrypted (decrypting it successfully means there's
 * nothing to do).
 */
return new class extends Migration
{
    public function up(): void
    {
        $blueprint = app(BlueprintExtensionLibrary::class);
        $current = $blueprint->dbGet('{identifier}', 'client_secret');

        if (!$current) {
            return;
        }

        try {
            Crypt::decryptString($current);
            // Already encrypted - nothing to do.
        } catch (\Throwable) {
            $blueprint->dbSet('{identifier}', 'client_secret', Crypt::encryptString($current));
        }
    }

    public function down(): void
    {
        $blueprint = app(BlueprintExtensionLibrary::class);
        $current = $blueprint->dbGet('{identifier}', 'client_secret');

        if (!$current) {
            return;
        }

        try {
            $blueprint->dbSet('{identifier}', 'client_secret', Crypt::decryptString($current));
        } catch (\Throwable) {
            // Already plaintext (or unrelated garbage) - leave it as-is.
        }
    }
};

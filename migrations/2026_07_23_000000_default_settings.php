<?php

use Illuminate\Support\Facades\DB;
use Illuminate\Database\Migrations\Migration;
use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary as BlueprintExtensionLibrary;

return new class extends Migration
{
    public function up(): void
    {
        $blueprint = app(BlueprintExtensionLibrary::class);

        $blueprint->dbSetMany('{identifier}', [
            'enabled' => '0',
            'issuer' => '',
            'client_id' => '',
            'client_secret' => '',
            'scopes' => 'openid profile email',
            'button_text' => 'Login with SSO',
            'hide_password_login' => '0',
            'claim_email' => 'email',
            'claim_username' => 'preferred_username',
            'claim_first_name' => 'given_name',
            'claim_last_name' => 'family_name',
            'claim_admin' => '',
            'claim_admin_value' => '',
        ]);
    }

    public function down(): void
    {
        DB::table('settings')->where('key', 'like', '{identifier}::%')->delete();
    }
};

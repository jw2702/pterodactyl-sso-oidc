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
            'acr_values' => '',
            'require_amr' => '',
        ]);
    }

    public function down(): void
    {
        DB::table('settings')->whereIn('key', ['{identifier}::acr_values', '{identifier}::require_amr'])->delete();
    }
};

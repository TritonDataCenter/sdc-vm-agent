var execFile = require('child_process').execFile;

function testFindSmartosImage(t, callback) {
    var args = ['list', '-H', '-j', '-o', 'uuid,tags', 'os=smartos'];
    var idx;
    var img;
    var imgs = {};
    var latest;
    var smartosImageUUID;

    execFile('/usr/sbin/imgadm', args, function _onImgadm(err, stdout) {
        t.ifError(err, 'load images from imgadm');
        if (err) {
            callback(smartosImageUUID);
            return;
        }

        imgs = JSON.parse(stdout);
        for (idx = 0; idx < imgs.length; idx++) {
            img = imgs[idx];
            if (img.manifest.tags.smartdc
                && (!latest || img.manifest.published_at > latest)) {
                // found a newer SmartOS img!
                smartosImageUUID = img.manifest.uuid;
                latest = img.manifest.published_at;
            }
        }

        t.ok(smartosImageUUID, 'found SmartOS image_uuid: ' + smartosImageUUID);
        callback(smartosImageUUID);
    });
}


module.exports = {
    testFindSmartosImage: testFindSmartosImage
};

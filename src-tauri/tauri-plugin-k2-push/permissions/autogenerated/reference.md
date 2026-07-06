## Default Permission

Default permissions for the k2-push plugin: availability probe,
permission request, token fetch, launch-tap read, and the event
listener plumbing for `tap`/`tokenRefresh`.

#### This default permission set includes the following:

- `allow-is-available`
- `allow-request-permission`
- `allow-get-token`
- `allow-get-launch-tap`
- `allow-register-listener`
- `allow-remove-listener`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`k2-push:allow-get-launch-tap`

</td>
<td>

Enables the get_launch_tap command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-get-launch-tap`

</td>
<td>

Denies the get_launch_tap command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:allow-get-token`

</td>
<td>

Enables the get_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-get-token`

</td>
<td>

Denies the get_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:allow-is-available`

</td>
<td>

Enables the is_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-is-available`

</td>
<td>

Denies the is_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:allow-request-permission`

</td>
<td>

Enables the request_permission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`k2-push:deny-request-permission`

</td>
<td>

Denies the request_permission command without any pre-configured scope.

</td>
</tr>
</table>
